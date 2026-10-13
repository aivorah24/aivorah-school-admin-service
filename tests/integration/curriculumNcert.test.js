const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const ADMIN = { id: 'a1', role: 'school_admin', school_id: 's1' };

beforeEach(() => { mockSb.reset(); mockSb.supabase.from.mockClear(); });

function chainCalls(table, method) {
  return mockSb.supabase.from.mock.calls
    .map((c, i) => (c[0] === table ? mockSb.supabase.from.mock.results[i].value[method].mock.calls : []))
    .flat();
}

describe('"NCERT" is stored and shown as CBSE', () => {
  test('PATCH student with curriculum NCERT stores CBSE', async () => {
    mockSb.setTable('users', [{ data: ADMIN, error: null }, { data: [{ id: 'st1', curriculum: 'NCERT' }], error: null }, { data: null, error: null }]);
    const res = await request(app).patch('/school-admin/students/st1?adminEmail=admin@school.test').send({ curriculum: 'ncert' });
    expect(res.status).toBe(200);
    expect(chainCalls('users', 'update')[0][0]).toEqual({ curriculum: 'CBSE' });
  });

  test('facets: a legacy NCERT school offers only CBSE', async () => {
    mockSb.setTable('users', [{ data: ADMIN, error: null }, { data: [{ grade: 'Grade 8', section: 'A', curriculum: 'NCERT' }], error: null }]);
    mockSb.setTable('schools', { data: { curriculum: 'NCERT' }, error: null });
    const res = await request(app).get('/school-admin/students/facets?adminEmail=admin@school.test');
    expect(res.status).toBe(200);
    expect(res.body.curriculums).toEqual(['CBSE']);
  });

  test('facets: mixed school lists CBSE once for NCERT + CBSE students', async () => {
    mockSb.setTable('users', [{ data: ADMIN, error: null }, { data: [{ grade: 'Grade 8', curriculum: 'NCERT' }, { grade: 'Grade 8', curriculum: 'CBSE' }], error: null }]);
    mockSb.setTable('schools', { data: { curriculum: null }, error: null });
    const res = await request(app).get('/school-admin/students/facets?adminEmail=admin@school.test');
    expect(res.body.curriculums).toEqual(['CBSE']);
  });

  test('list: CBSE filter also matches legacy NCERT rows, which come back as CBSE', async () => {
    mockSb.setTable('users', [{ data: ADMIN, error: null }, { data: [{ id: 'st1', name: 'A', email: 'a@s.test', grade: 'Grade 8', curriculum: 'NCERT', status: 'active' }], error: null }]);
    const res = await request(app).get('/school-admin/students?adminEmail=admin@school.test&curriculum=CBSE');
    expect(res.status).toBe(200);
    expect(chainCalls('users', 'in')).toContainEqual(['curriculum', ['CBSE', 'NCERT']]);
    const items = res.body.items || res.body.students || res.body;
    expect(items[0].curriculum).toBe('CBSE');
  });
});
