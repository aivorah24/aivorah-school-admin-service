const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);
jest.mock('../../services/firebaseAuth', () => ({
  signUp: jest.fn(),
  deleteAccount: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../services/parentAccounts', () => ({
  generateParentLoginId: jest.fn(({ attempt = 0 } = {}) => Promise.resolve(`p${7 + attempt}@aivorah.parent`)),
}));
jest.mock('../../services/mailer', () => ({
  sendCredentialsEmail: jest.fn(() => Promise.resolve()),
  sendOwnAccountCredentialsEmail: jest.fn(() => Promise.resolve()),
}));

const request = require('supertest');
const app = require('../../index');
const firebaseAuth = require('../../services/firebaseAuth');

const ADMIN = { data: { id: 'a1', role: 'school_admin', school_id: 's1' }, error: null };
const FREE = { data: null, error: null };
const emailExists = () => Promise.reject(Object.assign(new Error('EMAIL_EXISTS'), { code: 'EMAIL_EXISTS' }));
const body = { firstName: 'Sai', lastName: 'S', grade: 'Grade 11', section: 'B' };
const post = (b) => request(app).post('/school-admin/students?adminEmail=admin@school.test').send(b);

beforeEach(() => {
  mockSb.reset();
  jest.clearAllMocks();
  firebaseAuth.signUp.mockReset();
  firebaseAuth.signUp.mockImplementation((email) => Promise.resolve({ uid: `uid:${email}`, idToken: `tok:${email}` }));
  mockSb.setTable('schools', { data: { name: 'TSRA', curriculum: null }, error: null });
});

test('blank email → a generated student login, never an empty email', async () => {
  mockSb.setTable('users', [ADMIN, FREE /* count */, FREE /* dup */, FREE /* insert */]);
  const res = await post({ ...body, email: '' });
  expect(res.status).toBe(201);
  expect(res.body.email).toMatch(/^sai\.s\.\d+@tsra\.student$/);
  expect(firebaseAuth.signUp).toHaveBeenCalledWith(res.body.email, expect.any(String));
});

test('generated student login already in Firebase → regenerated', async () => {
  firebaseAuth.signUp.mockImplementationOnce(emailExists);
  mockSb.setTable('users', [ADMIN, FREE, FREE, FREE, FREE]);
  const res = await post(body);
  expect(res.status).toBe(201);
  const tried = firebaseAuth.signUp.mock.calls.map((c) => c[0]);
  expect(tried).toHaveLength(2);
  expect(tried[0]).not.toBe(tried[1]);
  expect(res.body.email).toBe(tried[1]);
});

test('typed email already registered → 409 "This email is already registered."', async () => {
  mockSb.setTable('users', [ADMIN, FREE /* count */, { data: { id: 'u9', role: 'student' }, error: null }]);
  const res = await post({ ...body, email: 'taken@x.test' });
  expect(res.status).toBe(409);
  expect(res.body).toEqual({ error: 'This email is already registered.', code: 'EMAIL_EXISTS' });
  expect(firebaseAuth.signUp).not.toHaveBeenCalled();
});

test('parent name + blank parent email: colliding generated parent login is regenerated', async () => {
  firebaseAuth.signUp
    .mockImplementationOnce((email) => Promise.resolve({ uid: 'student-uid', idToken: 'student-tok' }))
    .mockImplementationOnce(emailExists);
  mockSb.setTable('users', [ADMIN, FREE, FREE, FREE /* student insert */, FREE /* p7 */, FREE /* p8 */, FREE /* parent insert */]);
  mockSb.setTable('parent_children', FREE);
  const res = await post({ ...body, parentName: 'Asha Rao' });
  expect(res.status).toBe(201);
  expect(firebaseAuth.signUp.mock.calls.slice(1).map((c) => c[0])).toEqual(['p7@aivorah.parent', 'p8@aivorah.parent']);
  const linkInsert = mockSb.supabase.from.mock.results
    .filter((r, i) => mockSb.supabase.from.mock.calls[i][0] === 'parent_children')
    .flatMap((r) => r.value.insert.mock.calls);
  expect(linkInsert[0][0]).toEqual(expect.objectContaining({ parent_email: 'p8@aivorah.parent' }));
});

test('parent account fails after the student was created → student rolled back (Firebase + rows), 409', async () => {
  firebaseAuth.signUp
    .mockImplementationOnce(() => Promise.resolve({ uid: 'student-uid', idToken: 'student-tok' }))
    .mockImplementationOnce(emailExists);
  mockSb.setTable('users', [ADMIN, FREE, FREE, FREE, FREE, FREE, FREE, FREE]);
  const res = await post({ ...body, parentName: 'Asha Rao', parentEmail: 'ghost@x.test' });
  expect(res.status).toBe(409);
  expect(res.body).toEqual({ error: 'This parent email is already registered.', code: 'EMAIL_EXISTS' });
  expect(firebaseAuth.deleteAccount).toHaveBeenCalledWith('student-tok');
  const userDeletes = mockSb.supabase.from.mock.results
    .filter((r, i) => mockSb.supabase.from.mock.calls[i][0] === 'users')
    .filter((r) => r.value.delete.mock.calls.length);
  expect(userDeletes).toHaveLength(1);
});
