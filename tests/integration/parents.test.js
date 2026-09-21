const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

jest.mock('../../services/teacherAccounts', () => ({
  generateSecurePassword: jest.fn(() => 'Sup3r#Pass'),
  createFirebaseAccount: jest.fn(() => Promise.resolve('firebase-uid-1')),
  toTitleCase: jest.fn((s) => s.replace(/\b\w/g, (c) => c.toUpperCase())),
}));
jest.mock('../../services/parentAccounts', () => ({
  generateParentLoginId: jest.fn(() => Promise.resolve('p7@aivorah.parent')),
}));

const request = require('supertest');
const app = require('../../index');
const { createFirebaseAccount } = require('../../services/teacherAccounts');

const SCHOOL_ADMIN = { id: 'admin-1', role: 'school_admin', school_id: 'school-1' };

beforeEach(() => { mockSb.reset(); jest.clearAllMocks(); });

describe('requireAdminScope gate', () => {
  test('rejects a request with no adminEmail', async () => {
    const res = await request(app).get('/school-admin/parents');
    expect(res.status).toBe(401);
  });
});

describe('GET /school-admin/parents', () => {
  test('lists parents with linked-student names and derived status', async () => {
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [{ id: 'p1', name: 'Alice Adams', email: 'alice@school.test', status: 'active', created_at: '2026-01-01' }], error: null },
      { data: [{ id: 'c1', name: 'Vihaan Kapoor' }], error: null },
    ]);
    mockSb.setTable('user_preferences', [{ data: [{ user_email: 'alice@school.test', data: { mustChangePassword: false } }], error: null }]);
    mockSb.setTable('parent_children', { data: [{ parent_email: 'alice@school.test', child_id: 'c1' }], error: null });

    const res = await request(app).get('/school-admin/parents?adminEmail=admin@school.test');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'p1', name: 'Alice Adams', email: 'alice@school.test', linkedStudents: ['Vihaan Kapoor'], status: 'active', joinedAt: '2026-01-01' }]);
  });

  test('a parent with no linked children gets an empty linkedStudents array', async () => {
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [{ id: 'p2', name: 'Bob Brown', email: 'bob@school.test', status: 'active', created_at: '2026-01-02' }], error: null },
    ]);
    mockSb.setTable('user_preferences', [{ data: [{ user_email: 'bob@school.test', data: { mustChangePassword: true } }], error: null }]);
    mockSb.setTable('parent_children', { data: [], error: null });

    const res = await request(app).get('/school-admin/parents?adminEmail=admin@school.test');
    expect(res.body[0]).toEqual(expect.objectContaining({ linkedStudents: [], status: 'invited' }));
  });

  test('rejects a global admin with no schoolId', async () => {
    mockSb.setTable('users', [{ data: { id: 'admin-2', role: 'super_admin', school_id: null }, error: null }]);
    const res = await request(app).get('/school-admin/parents?adminEmail=super@x.test');
    expect(res.status).toBe(400);
  });
});

describe('POST /school-admin/parents', () => {
  const body = { firstName: 'E2E', lastName: 'Test' };

  test('rejects a global admin', async () => {
    mockSb.setTable('users', [{ data: { id: 'admin-2', role: 'super_admin', school_id: null }, error: null }]);
    const res = await request(app).post('/school-admin/parents?adminEmail=super@x.test').send(body);
    expect(res.status).toBe(400);
  });

  test('rejects missing first/last name', async () => {
    mockSb.setTable('users', [{ data: SCHOOL_ADMIN, error: null }]);
    const res = await request(app).post('/school-admin/parents?adminEmail=admin@school.test').send({ firstName: '', lastName: '' });
    expect(res.status).toBe(400);
  });

  test('a child entry with no admission number or name is reported unresolved, and nothing is created', async () => {
    mockSb.setTable('users', [{ data: SCHOOL_ADMIN, error: null }]);
    const res = await request(app).post('/school-admin/parents?adminEmail=admin@school.test').send({ ...body, children: [{}] });
    expect(res.status).toBe(400);
    expect(res.body.unresolved).toEqual([{ index: 0, reason: 'Enter an admission number or a student name.' }]);
    expect(createFirebaseAccount).not.toHaveBeenCalled();
  });

  test('a child entry matching zero students is reported unresolved', async () => {
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [], error: null },
    ]);
    const res = await request(app).post('/school-admin/parents?adminEmail=admin@school.test').send({ ...body, children: [{ admissionNumber: 'TSRA-999' }] });
    expect(res.status).toBe(400);
    expect(res.body.unresolved[0].reason).toMatch(/No student found with admission number/);
  });

  test('a child entry matching more than one student is reported unresolved', async () => {
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [{ id: 's1' }, { id: 's2' }], error: null },
    ]);
    const res = await request(app).post('/school-admin/parents?adminEmail=admin@school.test').send({ ...body, children: [{ name: 'Common Name' }] });
    expect(res.status).toBe(400);
    expect(res.body.unresolved[0].reason).toMatch(/2 students match/);
  });

  test('rejects a duplicate email', async () => {
    mockSb.setTable('schools', { data: { name: 'Test School' }, error: null });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: { id: 'existing' }, error: null },
    ]);

    const res = await request(app).post('/school-admin/parents?adminEmail=admin@school.test').send({ ...body, email: 'taken@school.test' });
    expect(res.status).toBe(409);
    expect(createFirebaseAccount).not.toHaveBeenCalled();
  });

  test('creates a parent with no children, generating a p<N>@aivorah.parent login id', async () => {
    mockSb.setTable('schools', { data: { name: 'Test School' }, error: null });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: null, error: null }, // no duplicate
      { data: null, error: null }, // insert
    ]);
    mockSb.setTable('parent_children', { data: null, error: null });
    mockSb.setTable('user_preferences', { data: null, error: null });

    const res = await request(app).post('/school-admin/parents?adminEmail=admin@school.test').send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ name: 'E2E Test', email: 'p7@aivorah.parent', password: 'Sup3r#Pass', status: 'invited' }));
    expect(createFirebaseAccount).toHaveBeenCalledWith('p7@aivorah.parent', 'Sup3r#Pass');
  });

  test('creates a parent with a resolved child and links parent_children', async () => {
    mockSb.setTable('schools', { data: { name: 'Test School' }, error: null });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [{ id: 'student-1', name: 'Vihaan Kapoor' }], error: null }, // child resolution
      { data: null, error: null }, // no duplicate
      { data: null, error: null }, // insert
    ]);
    mockSb.setTable('parent_children', { data: null, error: null });
    mockSb.setTable('user_preferences', { data: null, error: null });

    const res = await request(app).post('/school-admin/parents?adminEmail=admin@school.test').send({ ...body, children: [{ admissionNumber: 'TSRA-1005' }] });

    expect(res.status).toBe(201);
  });
});
