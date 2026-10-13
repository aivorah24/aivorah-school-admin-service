const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const { notifyClassPost, clearClassPostNotifications, classLabel, snippet } = require('../../services/classPostNotifications');

const POST = {
  id: 'post-1', school_id: 'school-1', grade: 'Grade 5', section: 'A', status: 'published',
  caption: 'Science   fair photos', created_by: 'teacher@school.test', created_at: '2026-10-13T09:00:00.000Z',
};
const STUDENTS = [{ id: 's1', email: 'asha@school.test', section: 'A' }, { id: 's2', email: 'ravi@school.test', section: 'A' }];

beforeEach(() => {
  mockSb.reset();
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => console.log.mockRestore());

const usersChain = () => mockSb.supabase.from.mock.results.find((r, i) => mockSb.supabase.from.mock.calls[i][0] === 'users').value;

describe('notifyClassPost', () => {
  test('fans out to every student of the class (school + grade + section) via notify_event with parents on', async () => {
    mockSb.setTable('users', { data: STUDENTS, error: null });
    mockSb.setTable('parent_children', { data: [{ parent_email: 'mom@home.test' }], error: null });
    mockSb.setTable('user_preferences', { data: [], error: null });
    mockSb.setRpc({ data: { inserted: [{}, {}, {}] }, error: null });

    const r = await notifyClassPost(POST);

    expect(r).toEqual({ ok: true, inserted: 3 });
    const users = usersChain();
    expect(users.eq).toHaveBeenCalledWith('school_id', 'school-1');
    expect(users.eq).toHaveBeenCalledWith('grade', 'Grade 5');
    expect(users.eq).toHaveBeenCalledWith('role', 'student');
    const [fn, { p_event }] = mockSb.supabase.rpc.mock.calls[0];
    expect(fn).toBe('notify_event');
    expect(p_event).toMatchObject({
      type: 'class_post', entity_type: 'class_post', entity_id: 'post-1', version: POST.created_at,
      student_ids: ['s1', 's2'], exclude_emails: [], actor_email: 'teacher@school.test', actor_role: 'teacher',
      title: 'New class post: Grade 5-A', body: 'Science fair photos',
      parent_title: 'New class post for {child}: Grade 5-A',
      data: { postId: 'post-1', grade: 'Grade 5', section: 'A' },
    });
    expect(p_event.notify_parents).toBeUndefined(); // default true in notify_event
  });

  test('students and parents who turned notifications off are excluded', async () => {
    mockSb.setTable('users', { data: STUDENTS, error: null });
    mockSb.setTable('parent_children', { data: [{ parent_email: 'Mom@Home.test' }, { parent_email: 'dad@home.test' }], error: null });
    mockSb.setTable('user_preferences', { data: [
      { user_email: 'mom@home.test', data: { teacherMessages: false } },
      { user_email: 'ravi@school.test', data: { classPosts: false } },
      { user_email: 'dad@home.test', data: { teacherMessages: true } },
    ], error: null });
    mockSb.setRpc({ data: { inserted: [] }, error: null });

    await notifyClassPost(POST);

    expect(mockSb.supabase.rpc.mock.calls[0][1].p_event.exclude_emails.sort()).toEqual(['mom@home.test', 'ravi@school.test']);
  });

  test('section is matched in code: other sections skipped, a null section matches a post with none', async () => {
    mockSb.setTable('users', { data: [...STUDENTS, { id: 's3', email: 'b@school.test', section: 'B' }], error: null });
    mockSb.setRpc({ data: { inserted: [] }, error: null });
    await notifyClassPost(POST);
    expect(mockSb.supabase.rpc.mock.calls[0][1].p_event.student_ids).toEqual(['s1', 's2']);

    mockSb.supabase.rpc.mockClear();
    mockSb.setTable('users', { data: [{ id: 's4', email: 'n@school.test', section: null }, { id: 's5', email: 'a@school.test', section: 'A' }], error: null });
    await notifyClassPost({ ...POST, section: '' });
    expect(mockSb.supabase.rpc.mock.calls[0][1].p_event.student_ids).toEqual(['s4']);
  });

  test('drafts and empty classes never notify', async () => {
    expect(await notifyClassPost({ ...POST, status: 'draft' })).toMatchObject({ ok: false, skipped: 'not_published' });
    mockSb.setTable('users', { data: [], error: null });
    expect(await notifyClassPost(POST)).toMatchObject({ ok: true, skipped: 'no_students' });
    expect(mockSb.supabase.rpc).not.toHaveBeenCalled();
  });

  test('never throws when notify_event fails (the post is already saved)', async () => {
    mockSb.setTable('users', { data: STUDENTS, error: null });
    mockSb.setRpc({ data: null, error: { message: 'violates check constraint' } });
    await expect(notifyClassPost(POST)).resolves.toMatchObject({ ok: false, error: 'violates check constraint' });
  });
});

describe('clearClassPostNotifications', () => {
  test('deletes the bell rows for that post only', async () => {
    mockSb.setTable('notifications', { data: null, error: null });
    await expect(clearClassPostNotifications('post-1')).resolves.toEqual({ ok: true });
    const chain = mockSb.supabase.from.mock.results[0].value;
    expect(mockSb.supabase.from).toHaveBeenCalledWith('notifications');
    expect(chain.delete).toHaveBeenCalled();
    expect(chain.eq).toHaveBeenCalledWith('entity_type', 'class_post');
    expect(chain.eq).toHaveBeenCalledWith('entity_id', 'post-1');
  });
});

test('labels and snippets', () => {
  expect(classLabel('Grade 5', '')).toBe('Grade 5');
  expect(snippet('x'.repeat(150))).toHaveLength(100);
});
