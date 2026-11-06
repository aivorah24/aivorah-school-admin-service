// A student archived by their old school joining a new one
// (services/studentTransfer.js): Add Student by email, the student's own
// join request, and archiving closing the old approved request.
const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);
jest.mock('../../services/firebaseAuth', () => ({
  signUp: jest.fn(),
  deleteAccount: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../services/mailer', () => ({
  sendCredentialsEmail: jest.fn(() => Promise.resolve()),
  sendOwnAccountCredentialsEmail: jest.fn(() => Promise.resolve()),
  sendB2BConversionWelcomeEmail: jest.fn(() => Promise.resolve()),
}));

const request = require('supertest');
const app = require('../../index');
const firebaseAuth = require('../../services/firebaseAuth');
const mailer = require('../../services/mailer');
const { transferVerdict } = require('../../services/studentTransfer');

const ADMIN = { data: { id: 'a1', role: 'school_admin', school_id: 's1' }, error: null };
const FREE = { data: null, error: null };
const body = { firstName: 'Riya', lastName: 'Sen', grade: 'Grade 6', section: 'B', email: 'riya@x.test' };
const post = (b) => request(app).post('/school-admin/students?adminEmail=admin@school.test').send(b);

// every call made on one table: [{ method, args }]
function callsOn(table) {
  return mockSb.supabase.from.mock.calls
    .map((c, i) => [c[0], mockSb.supabase.from.mock.results[i].value])
    .filter(([t]) => t === table)
    .map(([, chain]) => chain);
}

beforeEach(() => {
  mockSb.reset();
  jest.clearAllMocks();
  firebaseAuth.signUp.mockImplementation((email) => Promise.resolve({ uid: `uid:${email}`, idToken: `tok:${email}` }));
  mockSb.setTable('schools', { data: { name: 'New School', curriculum: null }, error: null });
});

describe('transferVerdict', () => {
  test.each([
    [{ role: 'student', status: 'archived', school_id: 's0' }, 'transfer'],
    [{ role: 'student', status: 'archived', school_id: 's1' }, 'archived_here'],
    [{ role: 'student', status: 'active', school_id: 's0' }, 'active_elsewhere'],
    [{ role: 'student', status: 'active', school_id: 's1' }, 'taken'],
    [{ role: 'student', status: 'active', school_id: null }, 'taken'],
    [{ role: 'teacher', status: 'archived', school_id: 's0' }, 'taken'],
  ])('%j -> %s', (user, verdict) => {
    expect(transferVerdict(user, 's1')).toBe(verdict);
  });
});

describe('Add Student with the email of an archived student', () => {
  const ARCHIVED_ELSEWHERE = { data: { id: 'old1', name: 'Riya Sen', email: 'riya@x.test', role: 'student', status: 'archived', school_id: 's0' }, error: null };

  test('moves the account to this school: active, new class, no new login or password', async () => {
    mockSb.setTable('users', [ADMIN, FREE /* count */, ARCHIVED_ELSEWHERE, FREE /* update */]);
    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'old1', email: 'riya@x.test', name: 'Riya Sen', transferred: true, grade: 'Grade 6', section: 'B', status: 'active' });
    expect(res.body.password).toBeUndefined();
    expect(firebaseAuth.signUp).not.toHaveBeenCalled();
    expect(mailer.sendCredentialsEmail).not.toHaveBeenCalled();

    const update = callsOn('users').flatMap((c) => c.update.mock.calls)[0][0];
    expect(update).toMatchObject({ school_id: 's1', school: 'New School', status: 'active', grade: 'Grade 6', section: 'B' });
    expect(update.admission_number).toBeTruthy();
    // old school's class-teacher links removed; no fresh stats row
    expect(callsOn('teacher_student')[0].delete).toHaveBeenCalled();
    expect(callsOn('teacher_students')[0].delete).toHaveBeenCalled();
    expect(callsOn('student_stats')).toHaveLength(0);
  });

  test('archived in this same school -> asked to restore instead', async () => {
    mockSb.setTable('users', [ADMIN, FREE, { data: { id: 'x', role: 'student', status: 'archived', school_id: 's1' }, error: null }]);
    const res = await post(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ARCHIVED_HERE');
  });

  test('still active at another school -> that school must archive first', async () => {
    mockSb.setTable('users', [ADMIN, FREE, { data: { id: 'x', role: 'student', status: 'active', school_id: 's0' }, error: null }]);
    const res = await post(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACTIVE_ELSEWHERE');
    expect(firebaseAuth.signUp).not.toHaveBeenCalled();
  });
});

describe('archiving closes the student\'s approved join request', () => {
  test('single archive', async () => {
    mockSb.setTable('users', [ADMIN, { data: [{ id: 'st1', email: 'kid@x.test' }], error: null }, FREE]);
    const res = await request(app).patch('/school-admin/students/st1/status?adminEmail=admin@school.test').send({ status: 'archived' });
    expect(res.status).toBe(200);
    const reqs = callsOn('school_access_requests');
    expect(reqs.flatMap((c) => c.update.mock.calls)).toEqual([[{ status: 'archived' }]]);
    const eqs = reqs.flatMap((c) => c.eq.mock.calls);
    expect(eqs).toEqual(expect.arrayContaining([['school_id', 's1'], ['status', 'approved']]));
  });

  test('making a student inactive leaves the requests alone', async () => {
    mockSb.setTable('users', [ADMIN, { data: [{ id: 'st1', email: 'kid@x.test' }], error: null }, FREE]);
    await request(app).patch('/school-admin/students/st1/status?adminEmail=admin@school.test').send({ status: 'inactive' });
    expect(callsOn('school_access_requests')).toHaveLength(0);
  });

  test('bulk archive', async () => {
    mockSb.setTable('users', [ADMIN, { data: [{ id: 'st1', email: 'a@x.test' }, { id: 'st2', email: 'b@x.test' }], error: null }, FREE]);
    const res = await request(app).post('/school-admin/students/bulk-status?adminEmail=admin@school.test').send({ studentIds: ['st1', 'st2'], status: 'archived' });
    expect(res.status).toBe(200);
    const ins = callsOn('school_access_requests').flatMap((c) => c.in.mock.calls);
    expect(ins[0]).toEqual(['user_email', ['a@x.test', 'b@x.test']]);
  });
});

describe('approving an archived student\'s request', () => {
  test('they become active in the new school and lose the old school\'s teacher links', async () => {
    mockSb.setTable('school_access_requests', [
      { data: { id: 'r1', school_id: 's1', status: 'pending', user_email: 'kid@x.test', grade: 'Grade 6', section: 'A' }, error: null },
      FREE,
    ]);
    mockSb.setTable('users', [ADMIN, { data: { id: 'st1', name: 'Kid', role: 'student', status: 'archived', school_id: 's0' }, error: null }, FREE]);
    mockSb.setTable('parent_children', { data: [], error: null });
    const res = await request(app).post('/school-admin/access-requests/r1/approve?adminEmail=admin@school.test');
    expect(res.status).toBe(200);
    const update = callsOn('users').flatMap((c) => c.update.mock.calls)[0][0];
    expect(update).toMatchObject({ school_id: 's1', status: 'active', grade: 'Grade 6', section: 'A' });
    expect(callsOn('teacher_student')[0].delete).toHaveBeenCalled();
  });

  test('an independent (never-school) student keeps the old behaviour: no status change', async () => {
    mockSb.setTable('school_access_requests', [
      { data: { id: 'r1', school_id: 's1', status: 'pending', user_email: 'kid@x.test' }, error: null },
      FREE,
    ]);
    mockSb.setTable('users', [ADMIN, { data: { id: 'st1', name: 'Kid', role: 'student', status: 'active', school_id: null }, error: null }, FREE]);
    mockSb.setTable('parent_children', { data: [], error: null });
    const res = await request(app).post('/school-admin/access-requests/r1/approve?adminEmail=admin@school.test');
    expect(res.status).toBe(200);
    const update = callsOn('users').flatMap((c) => c.update.mock.calls)[0][0];
    expect(update.status).toBeUndefined();
    expect(callsOn('teacher_student')).toHaveLength(0);
  });
});
