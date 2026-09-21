const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const SCHOOL_ADMIN = { id: 'admin-1', role: 'school_admin', school_id: 'school-1' };
const NO_SCHOOL_ADMIN = { id: 'admin-2', role: 'school_admin', school_id: null };

beforeEach(() => { mockSb.reset(); });

describe('requireAdminScope gate (applies to every route in this router)', () => {
  test('rejects a request with no adminEmail', async () => {
    const res = await request(app).get('/school-admin/grades-sections');
    expect(res.status).toBe(401);
  });

  test('rejects a school_admin with no school assigned', async () => {
    mockSb.setTable('users', { data: NO_SCHOOL_ADMIN, error: null });
    const res = await request(app).get('/school-admin/grades-sections?adminEmail=admin2@school.test');
    expect(res.status).toBe(403);
  });
});

describe('GET /school-admin/grades-sections', () => {
  test('returns the merged grades list for a school_admin', async () => {
    mockSb.setTable('users', { data: SCHOOL_ADMIN, error: null });
    mockSb.setTable('schools', {
      data: { academic_structure: { grades: [{ name: 'Grade 6', archived: false, sections: [] }] } },
      error: null,
    });
    // adminScope's lookup and buildGradesSectionsView's student-count query
    // both hit the 'users' table — sequence the two responses in call order.
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null }, // adminScope lookup
      { data: [], error: null },           // student counts query
    ]);

    const res = await request(app).get('/school-admin/grades-sections?adminEmail=admin@school.test');
    expect(res.status).toBe(200);
    expect(res.body.grades).toHaveLength(1);
    expect(res.body.grades[0].name).toBe('Grade 6');
  });

  test('400s for a global admin with no schoolId query param', async () => {
    // Allowlisted email -> global scope without touching the DB.
    const res = await request(app).get('/school-admin/grades-sections?adminEmail=kannansaimohan2003@gmail.com');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/schoolId required/i);
  });
});

describe('POST /school-admin/grades', () => {
  test('requires a non-empty name', async () => {
    mockSb.setTable('users', { data: SCHOOL_ADMIN, error: null });
    const res = await request(app).post('/school-admin/grades?adminEmail=admin@school.test').send({ name: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('rejects a global (non-school) admin — only a school_admin can add a grade', async () => {
    const res = await request(app)
      .post('/school-admin/grades?adminEmail=kannansaimohan2003@gmail.com')
      .send({ name: 'Grade 7' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/school administrator/i);
  });

  test('409s when the grade name already exists (case-insensitive)', async () => {
    mockSb.setTable('users', [{ data: SCHOOL_ADMIN, error: null }]);
    mockSb.setTable('schools', { data: { academic_structure: { grades: [{ name: 'Grade 6', archived: false, sections: [] }] } }, error: null });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [], error: null }, // student counts for the duplicate-check buildGradesSectionsView call
    ]);

    const res = await request(app).post('/school-admin/grades?adminEmail=admin@school.test').send({ name: 'grade 6' });
    expect(res.status).toBe(409);
  });

  test('creates a new grade and returns the updated list', async () => {
    // The mock is stateless — saveStructure()'s write isn't actually
    // persisted, so the final re-read needs its own fixture that already
    // reflects the post-write DB state, to verify the route's response
    // shaping (not the mock's persistence, which it doesn't have).
    mockSb.setTable('schools', [
      { data: { academic_structure: { grades: [] } }, error: null },                          // duplicate-check read
      { data: { academic_structure: { grades: [{ name: 'Grade 7', archived: false, sections: [] }] } }, error: null }, // post-write read
    ]);
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null }, // adminScope
      { data: [], error: null },           // buildGradesSectionsView #1 (duplicate check)
      { data: [], error: null },           // buildGradesSectionsView #2 (final response)
    ]);

    const res = await request(app).post('/school-admin/grades?adminEmail=admin@school.test').send({ name: 'Grade 7' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.grades.some((g) => g.name === 'Grade 7')).toBe(true);
  });
});

describe('POST /school-admin/grades/:grade/sections', () => {
  test('requires a non-empty section name', async () => {
    mockSb.setTable('users', { data: SCHOOL_ADMIN, error: null });
    const res = await request(app).post('/school-admin/grades/Grade%206/sections?adminEmail=admin@school.test').send({ name: '' });
    expect(res.status).toBe(400);
  });

  test('404s when the grade does not exist', async () => {
    mockSb.setTable('users', [{ data: SCHOOL_ADMIN, error: null }]);
    mockSb.setTable('schools', { data: { academic_structure: { grades: [] } }, error: null });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [], error: null },
    ]);

    const res = await request(app).post('/school-admin/grades/Ghost%20Grade/sections?adminEmail=admin@school.test').send({ name: 'A' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /school-admin/grades/:grade (rename)', () => {
  test('requires a non-empty new name', async () => {
    mockSb.setTable('users', { data: SCHOOL_ADMIN, error: null });
    const res = await request(app).patch('/school-admin/grades/Grade%206?adminEmail=admin@school.test').send({ name: '' });
    expect(res.status).toBe(400);
  });

  test('404s when the grade does not exist', async () => {
    mockSb.setTable('schools', { data: { academic_structure: { grades: [] } }, error: null });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [], error: null },
    ]);

    const res = await request(app).patch('/school-admin/grades/Ghost/?adminEmail=admin@school.test').send({ name: 'New' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /school-admin/grades/:grade/archive', () => {
  test('rejects a global (non-school) admin', async () => {
    const res = await request(app)
      .patch('/school-admin/grades/Grade%206/archive?adminEmail=kannansaimohan2003@gmail.com')
      .send({ archived: true });
    expect(res.status).toBe(400);
  });

  test('404s when the grade does not exist', async () => {
    mockSb.setTable('schools', { data: { academic_structure: { grades: [] } }, error: null });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [], error: null },
    ]);

    const res = await request(app).patch('/school-admin/grades/Ghost/archive?adminEmail=admin@school.test').send({ archived: true });
    expect(res.status).toBe(404);
  });

  test('archives an existing grade and returns the updated list', async () => {
    // Same stateless-mock caveat as the POST /grades test above.
    mockSb.setTable('schools', [
      { data: { academic_structure: { grades: [{ name: 'Grade 6', archived: false, sections: [] }] } }, error: null },
      { data: { academic_structure: { grades: [{ name: 'Grade 6', archived: true, sections: [] }] } }, error: null },
    ]);
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null }, // adminScope
      { data: [], error: null },           // buildGradesSectionsView #1
      { data: [], error: null },           // buildGradesSectionsView #2 (final response)
    ]);

    const res = await request(app).patch('/school-admin/grades/Grade%206/archive?adminEmail=admin@school.test').send({ archived: true });
    expect(res.status).toBe(200);
    expect(res.body.grades.find((g) => g.name === 'Grade 6').archived).toBe(true);
  });

  // archived defaults to true when not explicitly false — matches the
  // route's `req.body?.archived !== false` logic.
  test('defaults archived to true when the field is omitted', async () => {
    mockSb.setTable('schools', [
      { data: { academic_structure: { grades: [{ name: 'Grade 6', archived: false, sections: [] }] } }, error: null },
      { data: { academic_structure: { grades: [{ name: 'Grade 6', archived: true, sections: [] }] } }, error: null },
    ]);
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },
      { data: [], error: null },
      { data: [], error: null },
    ]);

    const res = await request(app).patch('/school-admin/grades/Grade%206/archive?adminEmail=admin@school.test').send({});
    expect(res.status).toBe(200);
    expect(res.body.grades.find((g) => g.name === 'Grade 6').archived).toBe(true);
  });
});
