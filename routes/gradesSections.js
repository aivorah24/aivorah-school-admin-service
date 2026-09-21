/**
 * Grades & Sections — a managed VIEW over the school's academic structure.
 * Ported from ai-mentor/server/routes/school-admin.js (the `/grades*`
 * handlers only — Classes and class-teacher assignment stay in the monolith
 * for now, out of scope for this migration).
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

// GET /grades-sections
router.get('/grades-sections', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const grades = await buildGradesSectionsView(schoolId);
    res.json({ grades });
  } catch (err) {
    console.error('[GET /grades-sections] error:', err.message);
    res.status(500).json({ error: 'Failed to load grades & sections' });
  }
});

// POST /grades  { name }
router.post('/grades', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can add a grade' });
  const schoolId = req.adminScope.schoolId;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Grade name is required' });
  try {
    const grades = await buildGradesSectionsView(schoolId);
    if (grades.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'That grade already exists' });
    }
    grades.push({ name, archived: false, sections: [] });
    await saveStructure(schoolId, grades);
    res.status(201).json({ ok: true, grades: await buildGradesSectionsView(schoolId) });
  } catch (err) {
    console.error('[POST /grades] error:', err.message);
    res.status(500).json({ error: 'Failed to add grade' });
  }
});

// POST /grades/:grade/sections  { name }
router.post('/grades/:grade/sections', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can add a section' });
  const schoolId = req.adminScope.schoolId;
  const gradeName = String(req.params.grade || '').trim();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Section name is required' });
  try {
    const grades = await buildGradesSectionsView(schoolId);
    const grade = grades.find((g) => g.name === gradeName);
    if (!grade) return res.status(404).json({ error: 'Grade not found' });
    if (grade.sections.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'That section already exists in this grade' });
    }
    grade.sections.push({ name, archived: false, studentCount: 0 });
    await saveStructure(schoolId, grades);
    res.status(201).json({ ok: true, grades: await buildGradesSectionsView(schoolId) });
  } catch (err) {
    console.error('[POST /grades/:grade/sections] error:', err.message);
    res.status(500).json({ error: 'Failed to add section' });
  }
});

// PATCH /grades/:grade  { name }  — rename a grade, cascades to every student in it.
router.patch('/grades/:grade', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can rename' });
  const schoolId = req.adminScope.schoolId;
  const gradeName = String(req.params.grade || '').trim();
  const newName = String(req.body?.name || '').trim();
  if (!newName) return res.status(400).json({ error: 'New name is required' });
  try {
    const grades = await buildGradesSectionsView(schoolId);
    const grade = grades.find((g) => g.name === gradeName);
    if (!grade) return res.status(404).json({ error: 'Grade not found' });
    if (grades.some((g) => g !== grade && g.name.toLowerCase() === newName.toLowerCase())) {
      return res.status(409).json({ error: 'Another grade already has that name' });
    }
    grade.name = newName;
    await saveStructure(schoolId, grades);
    await supabase.from('users').update({ grade: newName })
      .eq('school_id', schoolId).eq('role', 'student').eq('grade', gradeName);
    res.json({ ok: true, grades: await buildGradesSectionsView(schoolId) });
  } catch (err) {
    console.error('[PATCH /grades/:grade] error:', err.message);
    res.status(500).json({ error: 'Failed to rename' });
  }
});

// PATCH /grades/:grade/archive  { archived: bool }
router.patch('/grades/:grade/archive', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can archive' });
  const schoolId = req.adminScope.schoolId;
  const gradeName = String(req.params.grade || '').trim();
  const archived = req.body?.archived !== false; // default true
  try {
    const grades = await buildGradesSectionsView(schoolId);
    const grade = grades.find((g) => g.name === gradeName);
    if (!grade) return res.status(404).json({ error: 'Grade not found' });
    grade.archived = archived;
    await saveStructure(schoolId, grades);
    res.json({ ok: true, grades: await buildGradesSectionsView(schoolId) });
  } catch (err) {
    console.error('[PATCH /grades/:grade/archive] error:', err.message);
    res.status(500).json({ error: 'Failed to archive' });
  }
});

module.exports = router;
