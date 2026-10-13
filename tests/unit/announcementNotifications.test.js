const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const {
  notifyAnnouncement, clearAnnouncementNotifications, sweepDueAnnouncements, isLiveForReaders, snippet, notificationTitle,
} = require('../../services/announcementNotifications');

const LIVE = {
  id: 'ann-1', title: 'Sports Day', body: 'Dear Parents,\n\n**Sports Day** is on [Friday](https://x.test).\n- Wear whites',
  severity: 'info', display_type: 'both', status: 'published', starts_at: null, expires_at: null,
  content_version: 1, notified_version: null, created_by: 'admin@school.test',
};
const USERS = [
  { id: 'u1', email: 'asha@school.test', role: 'student' },
  { id: 'u2', email: 'mom@home.test', role: 'parent' },
  { id: 'u3', email: 'admin@school.test', role: 'school_admin' },
];

const chainsFor = (table) => mockSb.supabase.from.mock.calls
  .map((c, i) => [c[0], mockSb.supabase.from.mock.results[i].value])
  .filter(([t]) => t === table).map(([, chain]) => chain);
const upsertedRows = () => chainsFor('notifications').flatMap((c) => c.upsert.mock.calls.map((call) => call[0])).flat();

beforeEach(() => {
  mockSb.reset();
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => console.log.mockRestore());

describe('notifyAnnouncement', () => {
  test('school-wide announcement: one bell row per targeted user, author skipped, version marked', async () => {
    mockSb.setTable('announcements', { data: LIVE, error: null });
    mockSb.setTable('announcement_targets', { data: [{ school_id: 'school-1', role: null, teacher_id: null }], error: null });
    mockSb.setTable('users', { data: USERS, error: null });
    mockSb.setTable('user_preferences', { data: [], error: null });
    mockSb.setTable('notifications', { data: null, error: null });

    const r = await notifyAnnouncement('ann-1');

    expect(r).toEqual({ ok: true, inserted: 2 });
    const users = chainsFor('users')[0];
    expect(users.in).toHaveBeenCalledWith('role', ['student', 'parent', 'teacher', 'school_admin']);
    expect(users.eq).toHaveBeenCalledWith('school_id', 'school-1');
    const rows = upsertedRows();
    expect(rows.map((x) => [x.recipient_id, x.recipient_role])).toEqual([['u1', 'student'], ['u2', 'parent']]);
    expect(rows[0]).toMatchObject({
      type: 'announcement', entity_type: 'announcement', entity_id: 'ann-1',
      title: 'New announcement: Sports Day', body: 'Dear Parents, Sports Day is on Friday. Wear whites',
      event_key: 'announcement:announcement:ann-1:v1', data: { announcementId: 'ann-1', severity: 'info', displayType: 'both' },
    });
    expect(chainsFor('notifications')[0].upsert.mock.calls[0][1]).toEqual({ onConflict: 'recipient_id,event_key', ignoreDuplicates: true });
    const mark = chainsFor('announcements').find((c) => c.update.mock.calls.length);
    expect(mark.update).toHaveBeenCalledWith({ notified_version: 1 });
  });

  test('role-targeted announcement queries only that role', async () => {
    mockSb.setTable('announcements', { data: LIVE, error: null });
    mockSb.setTable('announcement_targets', { data: [{ school_id: 'school-1', role: 'parent', teacher_id: null }], error: null });
    mockSb.setTable('users', { data: [USERS[1]], error: null });
    mockSb.setTable('user_preferences', { data: [], error: null });

    await notifyAnnouncement('ann-1');

    expect(chainsFor('users')[0].eq).toHaveBeenCalledWith('role', 'parent');
    expect(upsertedRows().map((x) => x.recipient_id)).toEqual(['u2']);
  });

  test('teacher-scoped announcement goes to parents of that teacher\'s students', async () => {
    mockSb.setTable('announcements', { data: LIVE, error: null });
    mockSb.setTable('announcement_targets', { data: [{ school_id: 'school-1', role: 'parent', teacher_id: 't1' }], error: null });
    mockSb.setTable('teacher_student', { data: [{ student_id: 's1' }, { student_id: 's1' }], error: null });
    mockSb.setTable('parent_children', { data: [{ parent_email: 'Mom@Home.test' }], error: null });
    mockSb.setTable('users', { data: [USERS[1]], error: null });
    mockSb.setTable('user_preferences', { data: [], error: null });

    await notifyAnnouncement('ann-1');

    expect(chainsFor('teacher_student')[0].eq).toHaveBeenCalledWith('teacher_id', 't1');
    expect(chainsFor('parent_children')[0].in).toHaveBeenCalledWith('child_id', ['s1']);
    expect(chainsFor('users')[0].in).toHaveBeenCalledWith('email', ['mom@home.test']);
    expect(upsertedRows().map((x) => x.recipient_id)).toEqual(['u2']);
  });

  test('users who turned announcements off are skipped', async () => {
    mockSb.setTable('announcements', { data: LIVE, error: null });
    mockSb.setTable('announcement_targets', { data: [], error: null });
    mockSb.setTable('users', { data: USERS, error: null });
    mockSb.setTable('user_preferences', { data: [{ user_email: 'mom@home.test', data: { announcements: false } }], error: null });

    await notifyAnnouncement('ann-1');

    expect(upsertedRows().map((x) => x.recipient_id)).toEqual(['u1']);
  });

  test('already notified, drafts, future and expired announcements never notify', async () => {
    for (const a of [
      { ...LIVE, notified_version: 1 },
      { ...LIVE, status: 'draft' },
      { ...LIVE, starts_at: '2999-01-01T00:00:00Z' },
      { ...LIVE, expires_at: '2000-01-01T00:00:00Z' },
    ]) {
      mockSb.setTable('announcements', { data: a, error: null });
      expect((await notifyAnnouncement('ann-1')).ok).toBe(true);
    }
    expect(upsertedRows()).toEqual([]);
  });

  test('a content bump notifies again under a new key', async () => {
    mockSb.setTable('announcements', { data: { ...LIVE, content_version: 2, notified_version: 1 }, error: null });
    mockSb.setTable('announcement_targets', { data: [], error: null });
    mockSb.setTable('users', { data: [USERS[0]], error: null });
    mockSb.setTable('user_preferences', { data: [], error: null });

    await notifyAnnouncement('ann-1');

    expect(upsertedRows()[0]).toMatchObject({ title: 'Updated announcement: Sports Day', event_key: 'announcement:announcement:ann-1:v2' });
  });

  test('never throws when the insert fails', async () => {
    mockSb.setTable('announcements', { data: LIVE, error: null });
    mockSb.setTable('announcement_targets', { data: [], error: null });
    mockSb.setTable('users', { data: USERS, error: null });
    mockSb.setTable('user_preferences', { data: [], error: null });
    mockSb.setTable('notifications', { data: null, error: { message: 'violates check constraint' } });
    await expect(notifyAnnouncement('ann-1')).resolves.toMatchObject({ ok: false, error: 'violates check constraint' });
  });
});

describe('clearAnnouncementNotifications', () => {
  test('deletes that announcement\'s bell rows and resets notified_version', async () => {
    await expect(clearAnnouncementNotifications('ann-1')).resolves.toEqual({ ok: true });
    const del = chainsFor('notifications')[0];
    expect(del.delete).toHaveBeenCalled();
    expect(del.eq).toHaveBeenCalledWith('entity_type', 'announcement');
    expect(del.eq).toHaveBeenCalledWith('entity_id', 'ann-1');
    expect(chainsFor('announcements')[0].update).toHaveBeenCalledWith({ notified_version: null });
  });
});

describe('sweepDueAnnouncements', () => {
  test('notifies only live, not-yet-notified announcements and is throttled', async () => {
    mockSb.setTable('announcements', [
      { data: [
        { ...LIVE, id: 'due', status: 'scheduled', starts_at: '2000-01-01T00:00:00Z' },
        { ...LIVE, id: 'done', notified_version: 1 },
        { ...LIVE, id: 'later', status: 'scheduled', starts_at: '2999-01-01T00:00:00Z' },
      ], error: null },
      { data: { ...LIVE, id: 'due' }, error: null },
    ]);
    mockSb.setTable('announcement_targets', { data: [], error: null });
    mockSb.setTable('users', { data: [USERS[0]], error: null });
    mockSb.setTable('user_preferences', { data: [], error: null });

    expect(await sweepDueAnnouncements({ force: true })).toEqual({ ok: true, notified: 1 });
    expect(await sweepDueAnnouncements()).toEqual({ ok: true, skipped: 'throttled' });
  });
});

test('helpers', () => {
  expect(isLiveForReaders({ status: 'scheduled', starts_at: null })).toBe(false);
  expect(notificationTitle({ title: 'Fire drill', severity: 'critical', content_version: 1 })).toBe('Urgent: Fire drill');
  expect(notificationTitle({ title: 'Fees', severity: 'warning', content_version: 1 })).toBe('Important: Fees');
  expect(snippet('x'.repeat(200))).toHaveLength(140);
});
