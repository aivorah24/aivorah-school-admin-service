const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

jest.mock('../../services/teacherAccounts', () => ({
  generateSecurePassword: jest.fn(() => 'Sup3r#Pass'),
  generateStaffEmail: jest.fn((name, school, suffix) => `generated.${suffix}@school.test`),
  createFirebaseAccount: jest.fn(() => Promise.resolve('firebase-uid-1')),
  toTitleCase: jest.fn((s) => s.replace(/\b\w/g, (c) => c.toUpperCase())),
}));
jest.mock('../../services/mailer', () => ({
  sendOwnAccountCredentialsEmail: jest.fn(() => Promise.resolve()),
}));

const request = require('supertest');
const app = require('../../index');
const { createFirebaseAccount } = require('../../services/teacherAccounts');
const { sendOwnAccountCredentialsEmail } = require('../../services/mailer');

const SCHOOL_ADMIN = { id: 'admin-1', role: 'school_admin', school_id: 'school-1' };

beforeEach(() => { mockSb.reset(); jest.clearAllMocks(); });

describe('requireAdminScope gate', () => {
  test('rejects a request with no adminEmail', async () => {
    const res = await request(app).get('/school-admin/teachers');
    expect(res.status).toBe(401);
  });
});

describe('GET /school-admin/teachers', () => {
  test('lists teachers with their teaches/subjects and derived status', async () => {
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [{ id: 't1', name: 'Alice Adams', email: 'alice@school.test', status: 'active', created_at: '2026-01-01', grade: null, curriculum: null }], error: null },
    ]);
    mockSb.setTable('user_preferences', [
      { data: [{ user_email: 'alice@school.test', data: { mustChangePassword: false } }], error: null },
      { data: [{ user_email: 'alice@school.test', data: { teaches: [{ curriculum: 'CBSE', grade: 'Grade 3', subjects: ['Maths'] }] } }], error: null },
    ]);

    const res = await request(app).get('/school-admin/teachers?adminEmail=admin@school.test');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      id: 't1', name: 'Alice Adams', email: 'alice@school.test',
      teaches: [{ curriculum: 'CBSE', grade: 'Grade 3', subjects: ['Maths'] }],
      subjects: ['Maths'], grade: null, curriculum: null, status: 'active', joinedAt: '2026-01-01',
    }]);
  });

  test('a teacher with mustChangePassword true shows as invited', async () => {
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [{ id: 't1', name: 'Bob Brown', email: 'bob@school.test', status: 'active', created_at: '2026-01-02', grade: null, curriculum: null }], error: null },
    ]);
    mockSb.setTable('user_preferences', [
      { data: [{ user_email: 'bob@school.test', data: { mustChangePassword: true } }], error: null },
      { data: [], error: null },
    ]);

    const res = await request(app).get('/school-admin/teachers?adminEmail=admin@school.test');
    expect(res.body[0].status).toBe('invited');
  });

  test('rejects a global admin with no schoolId', async () => {
    mockSb.setTable('users', [{ data: { id: 'admin-2', role: 'super_admin', school_id: null }, error: null }]);
    const res = await request(app).get('/school-admin/teachers?adminEmail=super@x.test');
    expect(res.status).toBe(400);
  });
});

describe('POST /school-admin/teachers', () => {
  const body = { firstName: 'E2E', lastName: 'Test', teaches: [{ curriculum: 'CBSE', grade: 'Grade 3', subjects: ['Maths'] }] };

  test('rejects a global admin (only a school admin can add a teacher)', async () => {
    mockSb.setTable('users', [{ data: { id: 'admin-2', role: 'super_admin', school_id: null }, error: null }]);
    const res = await request(app).post('/school-admin/teachers?adminEmail=super@x.test').send(body);
    expect(res.status).toBe(400);
  });

  test('rejects a missing first/last name', async () => {
    mockSb.setTable('users', [{ data: SCHOOL_ADMIN, error: null }]);
    const res = await request(app).post('/school-admin/teachers?adminEmail=admin@school.test').send({ firstName: '', lastName: '' });
    expect(res.status).toBe(400);
  });

  test('rejects a duplicate email', async () => {
    mockSb.setTable('schools', { data: { name: 'Test School' }, error: null });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: { id: 'existing' }, error: null }, // duplicate check
    ]);

    const res = await request(app).post('/school-admin/teachers?adminEmail=admin@school.test').send({ ...body, email: 'taken@school.test' });
    expect(res.status).toBe(409);
    expect(createFirebaseAccount).not.toHaveBeenCalled();
  });

  test('creates a teacher, generates a login email when none given, and skips the credentials email', async () => {
    mockSb.setTable('schools', { data: { name: 'Test School' }, error: null });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: null, error: null }, // no duplicate
      { data: null, error: null }, // insert
    ]);
    mockSb.setTable('user_preferences', { data: null, error: null });

    const res = await request(app).post('/school-admin/teachers?adminEmail=admin@school.test').send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ name: 'E2E Test', password: 'Sup3r#Pass', subjects: ['Maths'], status: 'invited' }));
    expect(createFirebaseAccount).toHaveBeenCalledWith(res.body.email, 'Sup3r#Pass');
    expect(sendOwnAccountCredentialsEmail).not.toHaveBeenCalled();
  });

  test('creates a teacher with a real email override and emails the credentials', async () => {
    mockSb.setTable('schools', { data: { name: 'Test School' }, error: null });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);
    mockSb.setTable('user_preferences', { data: null, error: null });

    const res = await request(app).post('/school-admin/teachers?adminEmail=admin@school.test').send({ ...body, email: 'real.email@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('real.email@example.com');
    expect(sendOwnAccountCredentialsEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'real.email@example.com', role: 'teacher' }));
  });
});
