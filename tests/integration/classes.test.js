const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const SCHOOL_ADMIN = { id: 'admin-1', role: 'school_admin', school_id: 'school-1' };
const TEACHER = { id: 'teacher-1' };

beforeEach(() => { mockSb.reset(); });

describe('requireAdminScope gate', () => {
  test('rejects a request with no adminEmail', async () => {
    const res = await request(app).get('/school-admin/classes');
    expect(res.status).toBe(401);
  });
});

describe('GET /school-admin/classes', () => {
  test('flattens grades/sections into a class list, resolving class-teacher names', async () => {
    mockSb.setTable('schools', {
      data: {
        academic_structure: {
          grades: [{ name: 'Grade 6', archived: false, sections: [{ name: 'A', archived: false, classTeacherEmail: 'alice@school.test' }] }],
        },
      },
      error: null,
    });
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },                    // adminScope lookup
      { data: [], error: null },                               // student counts (buildGradesSectionsView)
      { data: [{ email: 'alice@school.test', name: 'Alice Adams' }], error: null }, // teacher name lookup
    ]);

    const res = await request(app).get('/school-admin/classes?adminEmail=admin@school.test');
    expect(res.status).toBe(200);
    expect(res.body.classes).toEqual([
      { grade: 'Grade 6', section: 'A', studentCount: 0, classTeacherEmail: 'alice@school.test', classTeacherName: 'Alice Adams' },
    ]);
  });

  test('excludes archived grades and sections', async () => {
    mockSb.setTable('schools', {
      data: {
        academic_structure: {
          grades: [
            { name: 'Grade 6', archived: true, sections: [{ name: 'A', archived: false, classTeacherEmail: null }] },
            { name: 'Grade 7', archived: false, sections: [{ name: 'A', archived: true, classTeacherEmail: null }] },
          ],
        },
      },
      error: null,
    });
    mockSb.setTable('users', [{ data: SCHOOL_ADMIN, error: null }, { data: [], error: null }]);

    const res = await request(app).get('/school-admin/classes?adminEmail=admin@school.test');
    expect(res.status).toBe(200);
    expect(res.body.classes).toEqual([]);
  });

  test('400s for a global admin with no schoolId query param', async () => {
    const res = await request(app).get('/school-admin/classes?adminEmail=kannansaimohan2003@gmail.com');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/schoolId required/i);
  });
});

describe('PATCH /school-admin/grades/:grade/sections/:section/class-teacher', () => {
  test('rejects a global (non-school) admin', async () => {
    const res = await request(app)
      .patch('/school-admin/grades/Grade%206/sections/A/class-teacher?adminEmail=kannansaimohan2003@gmail.com')
      .send({ teacherEmail: 'alice@school.test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/school administrator/i);
  });

  test('404s when the teacher email does not belong to a teacher in this school', async () => {
    mockSb.setTable('users', [{ data: SCHOOL_ADMIN, error: null }, { data: null, error: null }]);
    const res = await request(app)
      .patch('/school-admin/grades/Grade%206/sections/A/class-teacher?adminEmail=admin@school.test')
      .send({ teacherEmail: 'ghost@school.test' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('404s when the grade does not exist', async () => {
    mockSb.setTable('users', [{ data: SCHOOL_ADMIN, error: null }, { data: TEACHER, error: null }, { data: [], error: null }]);
    mockSb.setTable('schools', { data: { academic_structure: { grades: [] } }, error: null });

    const res = await request(app)
      .patch('/school-admin/grades/Grade%206/sections/A/class-teacher?adminEmail=admin@school.test')
      .send({ teacherEmail: 'alice@school.test' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Grade not found');
  });

  test('404s when the section does not exist', async () => {
    mockSb.setTable('users', [{ data: SCHOOL_ADMIN, error: null }, { data: TEACHER, error: null }, { data: [], error: null }]);
    mockSb.setTable('schools', { data: { academic_structure: { grades: [{ name: 'Grade 6', archived: false, sections: [] }] } }, error: null });

    const res = await request(app)
      .patch('/school-admin/grades/Grade%206/sections/A/class-teacher?adminEmail=admin@school.test')
      .send({ teacherEmail: 'alice@school.test' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Section not found');
  });

  test('assigns a class teacher, persists the overlay, and auto-links teacher_student', async () => {
    mockSb.setTable('users', [
      { data: SCHOOL_ADMIN, error: null },   // adminScope lookup
      { data: TEACHER, error: null },        // teacher-exists check
      { data: [], error: null },             // student counts (buildGradesSectionsView)
      { data: TEACHER, error: null },        // auto-link: teacher lookup
      { data: [{ id: 'student-1' }], error: null }, // auto-link: students in grade/section
    ]);
    mockSb.setTable('schools', { data: { academic_structure: { grades: [{ name: 'Grade 6', archived: false, sections: [{ name: 'A', archived: false, classTeacherEmail: null }] }] } }, error: null });

    const res = await request(app)
      .patch('/school-admin/grades/Grade%206/sections/A/class-teacher?adminEmail=admin@school.test')
      .send({ teacherEmail: 'Alice@School.test' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSb.supabase.from).toHaveBeenCalledWith('schools');
  });

  test('unassigns a class teacher with teacherEmail: null (no auto-link attempted)', async () => {
    mockSb.setTable('users', [{ data: SCHOOL_ADMIN, error: null }, { data: [], error: null }]);
    mockSb.setTable('schools', { data: { academic_structure: { grades: [{ name: 'Grade 6', archived: false, sections: [{ name: 'A', archived: false, classTeacherEmail: 'alice@school.test' }] }] } }, error: null });

    const res = await request(app)
      .patch('/school-admin/grades/Grade%206/sections/A/class-teacher?adminEmail=admin@school.test')
      .send({ teacherEmail: null });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
