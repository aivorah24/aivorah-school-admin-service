const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const { resolveAdminScope } = require('../../services/adminScope');

beforeEach(() => { mockSb.reset(); });

describe('resolveAdminScope', () => {
  test('rejects an empty email', async () => {
    const result = await resolveAdminScope('');
    expect(result).toEqual({ ok: false, statusCode: 401, error: 'adminEmail required' });
  });

  test('grants global scope to an allowlisted email without a DB lookup', async () => {
    const result = await resolveAdminScope('kannansaimohan2003@gmail.com');
    expect(result.ok).toBe(true);
    expect(result.scope).toMatchObject({ scopeType: 'global', schoolId: null, role: 'allowlist' });
    expect(mockSb.supabase.from).not.toHaveBeenCalled();
  });

  test('grants global scope to a super_admin user', async () => {
    mockSb.setTable('users', { data: { id: 'u1', role: 'super_admin', school_id: null }, error: null });
    const result = await resolveAdminScope('super@school.test');
    expect(result).toEqual({ ok: true, scope: { scopeType: 'global', schoolId: null, email: 'super@school.test', role: 'super_admin' } });
  });

  test('grants school scope to a school_admin with a school_id', async () => {
    mockSb.setTable('users', { data: { id: 'u1', role: 'school_admin', school_id: 'school-1' }, error: null });
    const result = await resolveAdminScope('admin@school.test');
    expect(result).toEqual({ ok: true, scope: { scopeType: 'school', schoolId: 'school-1', email: 'admin@school.test', role: 'school_admin' } });
  });

  test('rejects a school_admin with no school_id assigned (config error, not "all schools")', async () => {
    mockSb.setTable('users', { data: { id: 'u1', role: 'school_admin', school_id: null }, error: null });
    const result = await resolveAdminScope('admin@school.test');
    expect(result).toEqual({ ok: false, statusCode: 403, error: 'School administrator is not assigned to a school.' });
  });

  test('rejects a non-admin role (e.g. teacher)', async () => {
    mockSb.setTable('users', { data: { id: 'u1', role: 'teacher', school_id: 'school-1' }, error: null });
    const result = await resolveAdminScope('teacher@school.test');
    expect(result).toEqual({ ok: false, statusCode: 403, error: 'Not authorized to manage this school' });
  });

  test('rejects an email with no matching user row', async () => {
    mockSb.setTable('users', { data: null, error: null });
    const result = await resolveAdminScope('ghost@school.test');
    expect(result).toEqual({ ok: false, statusCode: 403, error: 'Not authorized to manage this school' });
  });

  test('surfaces a 500 when the DB lookup itself errors', async () => {
    mockSb.setTable('users', { data: null, error: { message: 'connection reset' } });
    const result = await resolveAdminScope('admin@school.test');
    expect(result).toEqual({ ok: false, statusCode: 500, error: 'Admin lookup failed' });
  });

  test('is case-insensitive and trims the email before lookup/comparison', async () => {
    mockSb.setTable('users', { data: { id: 'u1', role: 'school_admin', school_id: 'school-1' }, error: null });
    const result = await resolveAdminScope('  Admin@School.TEST  ');
    expect(result.scope.email).toBe('admin@school.test');
  });
});
