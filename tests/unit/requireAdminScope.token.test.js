const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);
const mockVerify = jest.fn();
jest.mock('../../services/firebaseToken', () => ({ verifyIdToken: (...a) => mockVerify(...a) }));

const { requireAdminScope } = require('../../services/adminScope');

const FOUNDER = 'kannansaimohan2003@gmail.com';

async function run({ token, adminEmail }) {
  const req = { method: 'GET', originalUrl: '/school-admin/x', headers: token ? { authorization: `Bearer ${token}` } : {}, query: adminEmail ? { adminEmail } : {}, body: {} };
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const next = jest.fn();
  await requireAdminScope(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  mockSb.reset();
  mockVerify.mockReset();
  mockVerify.mockImplementation(async (t) => { if (t === 'bad') throw new Error('bad'); return { email: t }; });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { delete process.env.AUTH_ENFORCE; });

describe('monitor mode (default) keeps current behaviour', () => {
  test('no token: adminEmail still resolves', async () => {
    const { next, req } = await run({ adminEmail: FOUNDER });
    expect(next).toHaveBeenCalled();
    expect(req.adminScope.scopeType).toBe('global');
  });

  test('token only (no adminEmail) resolves from the token', async () => {
    const { next, req } = await run({ token: FOUNDER });
    expect(next).toHaveBeenCalled();
    expect(req.adminEmail).toBe(FOUNDER);
  });
});

describe('enforce mode', () => {
  beforeEach(() => { process.env.AUTH_ENFORCE = 'enforce'; });

  test('no token -> 401 even with a founder adminEmail', async () => {
    const { next, res } = await run({ adminEmail: FOUNDER });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('invalid token -> 401', async () => {
    const { res } = await run({ token: 'bad', adminEmail: FOUNDER });
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('adminEmail different from signed-in user -> 403', async () => {
    const { next, res } = await run({ token: 'teacher@school.test', adminEmail: FOUNDER });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('matching token + adminEmail resolves', async () => {
    const { next, req } = await run({ token: FOUNDER, adminEmail: FOUNDER.toUpperCase() });
    expect(next).toHaveBeenCalled();
    expect(req.adminScope.scopeType).toBe('global');
  });
});
