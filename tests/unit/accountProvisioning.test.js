const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);
jest.mock('../../services/firebaseAuth', () => ({
  signUp: jest.fn(),
  deleteAccount: jest.fn(() => Promise.resolve()),
}));

const firebaseAuth = require('../../services/firebaseAuth');
const { provisionAccount, MAX_GENERATE_ATTEMPTS } = require('../../services/accountProvisioning');

const emailExists = () => Promise.reject(Object.assign(new Error('EMAIL_EXISTS'), { code: 'EMAIL_EXISTS' }));
const seqGenerate = jest.fn(({ attempt }) => `p${attempt + 1}@aivorah.parent`);
const base = { password: 'pw', conflictMessage: 'Taken.', generate: seqGenerate };

beforeEach(() => {
  mockSb.reset();
  jest.clearAllMocks();
  firebaseAuth.signUp.mockReset();
  firebaseAuth.signUp.mockImplementation((email) => Promise.resolve({ uid: `uid:${email}`, idToken: `tok:${email}` }));
});

test('blank email → generated login is used for Firebase and the users insert', async () => {
  const insertUser = jest.fn(() => Promise.resolve());
  const out = await provisionAccount({ ...base, email: '  ', insertUser });
  expect(out.email).toBe('p1@aivorah.parent');
  expect(firebaseAuth.signUp).toHaveBeenCalledWith('p1@aivorah.parent', 'pw');
  expect(insertUser).toHaveBeenCalledWith('p1@aivorah.parent', 'uid:p1@aivorah.parent');
});

test('generated candidate already in users → regenerated without touching Firebase', async () => {
  mockSb.setTable('users', [{ data: { id: 'x' }, error: null }, { data: null, error: null }]);
  const out = await provisionAccount({ ...base, insertUser: async () => {} });
  expect(out.email).toBe('p2@aivorah.parent');
  expect(firebaseAuth.signUp).toHaveBeenCalledTimes(1);
});

test('generated candidate already in Firebase only → regenerated, and the taken one is excluded', async () => {
  firebaseAuth.signUp.mockImplementationOnce(emailExists);
  const out = await provisionAccount({ ...base, insertUser: async () => {} });
  expect(out.email).toBe('p2@aivorah.parent');
  expect(seqGenerate.mock.calls[1][0].exclude.has('p1@aivorah.parent')).toBe(true);
});

test('gives up with a friendly error after MAX_GENERATE_ATTEMPTS collisions', async () => {
  firebaseAuth.signUp.mockImplementation(emailExists);
  await expect(provisionAccount({ ...base, insertUser: async () => {} }))
    .rejects.toThrow('Could not generate a unique login ID. Please try again.');
  expect(firebaseAuth.signUp).toHaveBeenCalledTimes(MAX_GENERATE_ATTEMPTS);
});

test('typed email in users → EMAIL_EXISTS 409 carrying the existing row', async () => {
  mockSb.setTable('users', { data: { id: 'u1', role: 'parent' }, error: null });
  const err = await provisionAccount({ ...base, email: 'A@x.test', insertUser: async () => {} }).catch((e) => e);
  expect(err).toMatchObject({ code: 'EMAIL_EXISTS', status: 409, message: 'Taken.', existing: { id: 'u1', role: 'parent' } });
  expect(firebaseAuth.signUp).not.toHaveBeenCalled();
});

test('typed email in Firebase only → EMAIL_EXISTS 409, never regenerated', async () => {
  firebaseAuth.signUp.mockImplementationOnce(emailExists);
  const err = await provisionAccount({ ...base, email: 'a@x.test', insertUser: async () => {} }).catch((e) => e);
  expect(err).toMatchObject({ code: 'EMAIL_EXISTS', status: 409, message: 'Taken.' });
  expect(seqGenerate).not.toHaveBeenCalled();
});

test('users insert fails after Firebase signup → Firebase account deleted, error rethrown', async () => {
  const insertUser = jest.fn(() => Promise.reject(new Error('insert failed')));
  await expect(provisionAccount({ ...base, email: 'a@x.test', insertUser })).rejects.toThrow('insert failed');
  expect(firebaseAuth.deleteAccount).toHaveBeenCalledWith('tok:a@x.test');
});

test('non-EMAIL_EXISTS Firebase errors propagate', async () => {
  firebaseAuth.signUp.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('WEAK_PASSWORD'), { code: 'WEAK_PASSWORD' })));
  await expect(provisionAccount({ ...base, insertUser: async () => {} })).rejects.toThrow('WEAK_PASSWORD');
});
