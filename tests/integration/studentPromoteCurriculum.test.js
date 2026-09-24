const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const ADMIN = { id: 'a1', role: 'school_admin', school_id: 's1' };

beforeEach(() => { mockSb.reset(); mockSb.supabase.from.mockClear(); });

function usersUpdatePatches() {
  return mockSb.supabase.from.mock.results
    .map((r, i) => ({ table: mockSb.supabase.from.mock.calls[i][0], chain: r.value }))
    .filter((c) => c.table === 'users' && c.chain.update.mock.calls.length)
    .map((c) => c.chain.update.mock.calls[0][0]);
}

async function promote(baseCurriculum, grade, studentCurriculum = baseCurriculum) {
  mockSb.setTable('users', [{ data: ADMIN, error: null }, { data: [{ id: 'st1', curriculum: studentCurriculum }], error: null }, { data: null, error: null }]);
  mockSb.setTable('schools', { data: { curriculum: baseCurriculum }, error: null });
  return request(app).post('/school-admin/students/bulk-grade?adminEmail=admin@school.test').send({ studentIds: ['st1'], grade });
}

describe('POST /school-admin/students/bulk-grade keeps curriculum in step with grade', () => {
  test.each([
    ['Grade 6', 'IB MYP'],
    ['Grade 11', 'IB DP'],
    ['Grade 5', 'IB PYP'],
  ])('IB school: promote to %s sets curriculum %s', async (grade, curriculum) => {
    const res = await promote('IB', grade);
    expect(res.status).toBe(200);
    expect(usersUpdatePatches()[0]).toEqual({ grade, curriculum });
  });

  test('non-IB school: only grade changes, curriculum untouched', async () => {
    const res = await promote('CBSE', 'Grade 6');
    expect(res.status).toBe(200);
    expect(usersUpdatePatches()[0]).toEqual({ grade: 'Grade 6' });
  });
});

describe('mixed-curriculum school (school base curriculum null, as in TSRA)', () => {
  test('IB PYP student promoted to Grade 6 becomes IB MYP', async () => {
    const res = await promote(null, 'Grade 6', 'IB PYP');
    expect(res.status).toBe(200);
    expect(usersUpdatePatches()[0]).toEqual({ grade: 'Grade 6', curriculum: 'IB MYP' });
  });

  test('CBSE student in the same school keeps CBSE', async () => {
    const res = await promote(null, 'Grade 6', 'CBSE');
    expect(res.status).toBe(200);
    expect(usersUpdatePatches()[0]).toEqual({ grade: 'Grade 6' });
  });
});

describe('PATCH /school-admin/students/:id', () => {
  test('IB school: changing grade also re-derives curriculum', async () => {
    mockSb.setTable('users', [{ data: ADMIN, error: null }, { data: [{ id: 'st1', curriculum: 'IB PYP' }], error: null }, { data: null, error: null }]);
    mockSb.setTable('schools', { data: { curriculum: 'IB' }, error: null });
    const res = await request(app).patch('/school-admin/students/st1?adminEmail=admin@school.test').send({ grade: 'Grade 6' });
    expect(res.status).toBe(200);
    expect(usersUpdatePatches()[0]).toEqual({ grade: 'Grade 6', curriculum: 'IB MYP' });
  });
});
