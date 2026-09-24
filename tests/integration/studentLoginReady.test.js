const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);
jest.mock('../../services/studentAccounts', () => ({
  ...jest.requireActual('../../services/studentAccounts'),
  createFirebaseAccount: jest.fn(() => Promise.resolve('firebase-uid-1')),
}));
jest.mock('../../services/mailer', () => ({
  sendCredentialsEmail: jest.fn(() => Promise.resolve()),
  sendOwnAccountCredentialsEmail: jest.fn(() => Promise.resolve()),
}));

const request = require('supertest');
const app = require('../../index');

beforeEach(() => { mockSb.reset(); });

// The frontend blocks real-email students unless user_preferences.accountStatus === 'active'.
test('POST /school-admin/students writes accountStatus=active so a real-email student can log in', async () => {
  mockSb.setTable('users', [
    { data: { id: 'a1', role: 'school_admin', school_id: 's1' }, error: null },
    { data: null, error: null },
    { data: null, error: null },
  ]);
  mockSb.setTable('schools', { data: { name: 'TSRA', curriculum: null }, error: null });

  const res = await request(app)
    .post('/school-admin/students?adminEmail=admin@school.test')
    .send({ firstName: 'Sai', lastName: 'S', grade: 'Grade 10', section: 'A', email: 'sai@gmail.com' });

  expect(res.status).toBeLessThan(300);
  const prefsCall = mockSb.supabase.from.mock.results
    .map((r, i) => ({ table: mockSb.supabase.from.mock.calls[i][0], chain: r.value }))
    .find((c) => c.table === 'user_preferences');
  expect(prefsCall.chain.upsert.mock.calls[0][0].data.accountStatus).toBe('active');
});
