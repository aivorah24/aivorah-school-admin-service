/**
 * Classes — every non-archived grade+section pair from the same merged
 * Grades & Sections view, each optionally assigned a class teacher. The
 * class-teacher assignment is stored on the same academic_structure overlay
 * (section.classTeacherEmail), so it survives grade/section renames.
 *
 * Ported from ai-mentor/server/routes/school-admin.js (the `/classes` and
 * class-teacher-assignment handlers only). GET /school-admin/teachers (used
 * by the assign-teacher picker) now lives in routes/teachers.js in this same
 * service.
 */
const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { buildGradesSectionsView, saveStructure } = require('../services/academicStructure');

// requireAdminScope is applied once, in index.js, for every route mounted
// under /school-admin — not per-router (see index.js's comment for why).

function effectiveSchoolId(req) {
  if (req.adminScope.scopeType === 'school') return req.adminScope.schoolId;
  return req.query.schoolId || null; // global admin may choose; null = needs explicit pick
}

// GET /classes — flattened list for the Classes screen.
router.get('/classes', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const grades = await buildGradesSectionsView(schoolId);
    const classes = [];
    const teacherEmails = new Set();
    for (const g of grades) {
      if (g.archived) continue;
      for (const s of g.sections) {
        if (s.archived) continue;
        if (s.classTeacherEmail) teacherEmails.add(s.classTeacherEmail);
        classes.push({ grade: g.name, section: s.name, studentCount: s.studentCount, classTeacherEmail: s.classTeacherEmail || null, classTeacherName: null });
      }
    }
    if (teacherEmails.size > 0) {
      const { data: teachers } = await supabase.from('users').select('email, name').in('email', [...teacherEmails]);
      const nameByEmail = new Map((teachers || []).map((t) => [t.email, t.name]));
      for (const c of classes) {
        if (c.classTeacherEmail) c.classTeacherName = nameByEmail.get(c.classTeacherEmail) || c.classTeacherEmail;
      }
    }
    res.json({ classes });
  } catch (err) {
    console.error('[GET /classes] error:', err.message);
    res.status(500).json({ error: 'Failed to load classes' });
  }
});

// PATCH /grades/:grade/sections/:section/class-teacher  { teacherEmail: string | null }
router.patch('/grades/:grade/sections/:section/class-teacher', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can assign a class teacher' });
  const schoolId = req.adminScope.schoolId;
  const gradeName = String(req.params.grade || '').trim();
  const sectionName = String(req.params.section || '').trim();
  const teacherEmail = req.body?.teacherEmail ? String(req.body.teacherEmail).trim().toLowerCase() : null;
  try {
    if (teacherEmail) {
      const { data: teacher } = await supabase.from('users').select('id').eq('email', teacherEmail).eq('role', 'teacher').eq('school_id', schoolId).maybeSingle();
      if (!teacher) return res.status(404).json({ error: 'That teacher was not found in this school' });
    }
    const grades = await buildGradesSectionsView(schoolId);
    const grade = grades.find((g) => g.name === gradeName);
    if (!grade) return res.status(404).json({ error: 'Grade not found' });
    const section = grade.sections.find((s) => s.name === sectionName);
    if (!section) return res.status(404).json({ error: 'Section not found' });
    section.classTeacherEmail = teacherEmail;
    await saveStructure(schoolId, grades);

    // Auto-link the class teacher to every student in this grade+section, so
    // Messages/Contacts can resolve their parents without a manual DB fix.
    if (teacherEmail) {
      try {
        const { data: teacher } = await supabase.from('users').select('id').eq('email', teacherEmail).eq('role', 'teacher').eq('school_id', schoolId).maybeSingle();
        const { data: students } = await supabase.from('users').select('id')
          .eq('role', 'student').eq('school_id', schoolId).eq('grade', gradeName).eq('section', sectionName);
        if (teacher && students?.length) {
          const rows = students.map((s) => ({ teacher_id: teacher.id, student_id: s.id, subject: 'Homeroom' }));
          await supabase.from('teacher_student').upsert(rows, { onConflict: 'teacher_id,student_id,subject', ignoreDuplicates: true });
        }
      } catch (linkErr) {
        console.error('[class-teacher] teacher_student auto-link failed:', linkErr.message);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[PATCH /grades/:grade/sections/:section/class-teacher] error:', err.message);
    res.status(500).json({ error: 'Failed to assign class teacher' });
  }
});

module.exports = router;
