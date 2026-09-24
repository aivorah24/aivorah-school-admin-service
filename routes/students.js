/**
 * Student Administration — ported verbatim from
 * ai-mentor/server/routes/school-admin.js (the Students section, lines
 * ~31-985 of that file). school_admin is the operational manager for their
 * own school's student roster — this is real write access, not read-only
 * oversight (confirmed 2026-07-12 on the original).
 */
const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const supabase = require('../services/supabase');
const {
  generateSecurePassword, generateStudentEmail, generateParentLoginId, createFirebaseAccount,
  toTitleCase, generateAdmissionNumber,
} = require('../services/studentAccounts');
const { sendCredentialsEmail, sendOwnAccountCredentialsEmail } = require('../services/mailer');
const { sortGradeNames, sortCurriculumNames, buildGradesSectionsView } = require('../services/academicStructure');
const { deriveStatusMap, displayStatus } = require('../services/userStatus');

function effectiveSchoolId(req) {
  if (req.adminScope.scopeType === 'school') return req.adminScope.schoolId;
  return req.query.schoolId || null;
}

// A school's stored `curriculum` is a BASE type (IB / CBSE / ICSE /
// Cambridge / ...), not a flat value — IB in particular spans PYP (Grade
// 1-5), MYP (Grade 6-10) and DP (Grade 11-12) within the SAME school, so the
// exact curriculum must be derived per-student from their own grade.
function resolveCurriculum(baseCurriculum, grade) {
  if (!baseCurriculum) return null;
  if (baseCurriculum !== 'IB') return baseCurriculum;
  const num = parseInt(String(grade || '').replace(/\D/g, ''), 10);
  if (!num) return 'IB PYP';
  if (num <= 5) return 'IB PYP';
  if (num <= 10) return 'IB MYP';
  return 'IB DP';
}

// Only IB derives its curriculum from grade (PYP/MYP/DP). A student counts as IB when the
// school is IB or their own curriculum is IB (mixed-curriculum schools); others keep theirs.
function derivedCurriculum(schoolBase, studentCurriculum, grade) {
  if (!/\d/.test(String(grade || ''))) return null;
  const isIB = schoolBase === 'IB' || /^IB/i.test(String(studentCurriculum || ''));
  return isIB ? resolveCurriculum('IB', grade) : null;
}

// GET /school-admin/students?adminEmail=&search=&grade=&section=&curriculum=&status=&sort=name|grade&dir=asc|desc&page=&limit=
router.get('/students', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    let query = supabase
      .from('users')
      .select('id, name, email, grade, section, curriculum, status, admission_number, created_at, last_active_at')
      .eq('school_id', schoolId)
      .eq('role', 'student');

    const search = String(req.query.search || '').trim();
    if (search) query = query.or(`name.ilike.%${search}%,admission_number.ilike.%${search}%`);
    if (req.query.grade && req.query.grade !== 'all') query = query.eq('grade', req.query.grade);
    if (req.query.section && req.query.section !== 'all') query = query.eq('section', req.query.section);
    if (req.query.curriculum && req.query.curriculum !== 'all') query = query.eq('curriculum', req.query.curriculum);

    const { data, error } = await query;
    if (error) throw error;
    let rows = data || [];

    const mustChangeMap = await deriveStatusMap(rows.map((r) => r.email));
    let items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      admissionNumber: r.admission_number,
      grade: r.grade,
      section: r.section,
      curriculum: r.curriculum,
      status: displayStatus(r.status, mustChangeMap.get(r.email) ?? true),
      joinedAt: r.created_at,
      lastActiveAt: r.last_active_at,
    }));

    const statusFilter = req.query.status;
    if (statusFilter && statusFilter !== 'all') items = items.filter((i) => i.status === statusFilter);
    else items = items.filter((i) => i.status !== 'archived'); // "All" excludes archived, same as the approved design

    const sortKey = ['grade', 'admissionNumber'].includes(req.query.sort) ? req.query.sort : 'name';
    const dir = req.query.dir === 'desc' ? -1 : 1;
    items.sort((a, b) => {
      if (sortKey === 'grade') {
        const g = sortGradeNames(a.grade || '', b.grade || '') || (a.section || '').localeCompare(b.section || '');
        return (g || a.name.localeCompare(b.name)) * dir;
      }
      if (sortKey === 'admissionNumber') {
        if (!a.admissionNumber && !b.admissionNumber) return a.name.localeCompare(b.name);
        if (!a.admissionNumber) return 1;
        if (!b.admissionNumber) return -1;
        return a.admissionNumber.localeCompare(b.admissionNumber, undefined, { numeric: true }) * dir;
      }
      return a.name.localeCompare(b.name) * dir;
    });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const total = items.length;
    const start = (page - 1) * limit;

    res.json({ items: items.slice(start, start + limit), total, page, limit });
  } catch (err) {
    console.error('[GET /school-admin/students] error:', err.message);
    res.status(500).json({ error: 'Failed to load students' });
  }
});

// GET /school-admin/students/facets — Grade/Section/Curriculum filter
// options for the WHOLE school, independent of pagination/current filters.
router.get('/students/facets', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const [{ data: school }, { data, error }] = await Promise.all([
      supabase.from('schools').select('curriculum').eq('id', schoolId).maybeSingle(),
      supabase.from('users').select('grade, section, curriculum').eq('school_id', schoolId).eq('role', 'student'),
    ]);
    if (error) throw error;
    const gradeSet = new Set();
    const sectionSet = new Set();
    const curriculumSet = new Set();
    for (const r of data || []) {
      const g = String(r.grade || '').trim();
      if (g) gradeSet.add(g);
      const s = String(r.section || '').trim();
      if (s) sectionSet.add(s);
      const c = String(r.curriculum || '').trim();
      if (c) curriculumSet.add(c);
    }

    const baseCurriculum = school?.curriculum || null;
    let curriculums;
    if (baseCurriculum === 'IB') {
      curriculums = ['IB PYP', 'IB MYP', 'IB DP'];
    } else if (baseCurriculum) {
      curriculums = [baseCurriculum];
    } else {
      curriculums = [...curriculumSet].sort(sortCurriculumNames);
    }

    res.json({
      grades: [...gradeSet].sort(sortGradeNames),
      sections: [...sectionSet].sort((a, b) => a.localeCompare(b)),
      curriculums,
    });
  } catch (err) {
    console.error('[GET /school-admin/students/facets] error:', err.message);
    res.status(500).json({ error: 'Failed to load grade/section/curriculum options' });
  }
});

// GET /school-admin/students/template.csv|.xlsx — a blank sample-only roster
// for ADDING new students (bulk import skips anyone already in the roster).
const TEMPLATE_HEADER = ['Student Name', 'Student Email', 'Admission No', 'Curriculum', 'Grade', 'Section', 'Parent Name', 'Parent Email', 'Parent Phone'];
const SAMPLE_ROW_COUNT = 4;
function buildSampleRows(baseCurriculum) {
  const c2 = resolveCurriculum(baseCurriculum, 'Grade 2') || '';
  const c3 = resolveCurriculum(baseCurriculum, 'Grade 3') || '';
  const c4 = resolveCurriculum(baseCurriculum, 'Grade 4') || '';
  const c5 = resolveCurriculum(baseCurriculum, 'Grade 5') || '';
  return [
    ['Aarav Sample (delete before uploading)', 'aarav.sample@example.com', 'ADM-0001', c3, 'Grade 3', 'A', 'Ravi Sample', 'ravi.sample@example.com', '+91 90000 00001'],
    ['Diya Sample (delete before uploading)', 'diya.sample@example.com', 'ADM-0002', c5, 'Grade 5', 'B', 'Meera Sample', 'meera.sample@example.com', '+91 90000 00002'],
    ['Kabir Sample (delete before uploading)', 'kabir.sample@example.com', 'ADM-0003', c2, 'Grade 2', 'A', 'Arjun Sample', 'arjun.sample@example.com', '+91 90000 00003'],
    ['Saanvi Sample (delete before uploading)', 'saanvi.sample@example.com', 'ADM-0004', c4, 'Grade 4', 'C', 'Nisha Sample', 'nisha.sample@example.com', '+91 90000 00004'],
  ];
}

function csvCell(value) {
  if (value === null || value === undefined || value === '') return '';
  return `"${String(value).replace(/"/g, '""')}"`;
}

function toCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

async function buildTemplateRows(schoolId) {
  const { data: school } = await supabase.from('schools').select('curriculum').eq('id', schoolId).maybeSingle();
  return buildSampleRows(school?.curriculum || null);
}

router.get('/students/template.csv', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const rows = await buildTemplateRows(schoolId);
    const csv = toCsv(TEMPLATE_HEADER, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="students_template.csv"');
    res.send(csv);
  } catch (err) {
    console.error('[GET /school-admin/students/template.csv] error:', err.message);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

router.get('/students/template.xlsx', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const rows = await buildTemplateRows(schoolId);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Aivorah';
    wb.created = new Date();
    const ws = wb.addWorksheet('Students', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    const COL_WIDTHS = [30, 30, 16, 12, 12, 12, 24, 28, 18];
    ws.columns = TEMPLATE_HEADER.map((header, i) => ({ header, key: `c${i}`, width: COL_WIDTHS[i] || 18 }));

    const HEADER_FILL = 'FF5C4A1E';
    const SAMPLE_FILL = 'FFFBF0DA';
    const THIN_BORDER = { style: 'thin', color: { argb: 'FFD9D3C7' } };

    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
      cell.alignment = { vertical: 'middle' };
      cell.border = { top: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER, bottom: THIN_BORDER };
    });
    headerRow.height = 22;

    const PHONE_COL = TEMPLATE_HEADER.indexOf('Parent Phone') + 1;
    if (PHONE_COL > 0) ws.getColumn(PHONE_COL).numFmt = '@';

    rows.forEach((rowValues, i) => {
      const row = ws.addRow(rowValues);
      const isSample = i < SAMPLE_ROW_COUNT;
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = { top: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER, bottom: THIN_BORDER };
        if (isSample) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAMPLE_FILL } };
          cell.font = { italic: true, color: { argb: 'FF8A7550' } };
        }
      });
      if (PHONE_COL > 0) {
        const phoneCell = row.getCell(PHONE_COL);
        phoneCell.numFmt = '@';
        if (phoneCell.value != null) phoneCell.value = String(phoneCell.value);
      }
    });

    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: TEMPLATE_HEADER.length } };

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="students_template.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[GET /school-admin/students/template.xlsx] error:', err.message);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

// GET /school-admin/students/:id — quick-inspect drawer data
router.get('/students/:id', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const { data: u, error } = await supabase
      .from('users').select('*').eq('id', req.params.id).eq('school_id', schoolId).eq('role', 'student').maybeSingle();
    if (error) throw error;
    if (!u) return res.status(404).json({ error: 'Student not found' });

    const mustChangeMap = await deriveStatusMap([u.email]);
    const { data: links } = await supabase
      .from('parent_children').select('parent_email').eq('child_id', u.id);
    let parent = null;
    if (links?.length) {
      const { data: p } = await supabase.from('users').select('name, email, phone').eq('email', links[0].parent_email).maybeSingle();
      if (p) parent = { name: p.name, email: p.email, phone: p.phone || '' };
    }

    res.json({
      id: u.id, name: u.name, email: u.email, admissionNumber: u.admission_number,
      grade: u.grade, section: u.section, curriculum: u.curriculum,
      status: displayStatus(u.status, mustChangeMap.get(u.email) ?? true),
      joinedAt: u.created_at,
      lastActiveAt: u.last_active_at,
      parent,
    });
  } catch (err) {
    console.error('[GET /school-admin/students/:id] error:', err.message);
    res.status(500).json({ error: 'Failed to load student' });
  }
});

// POST /school-admin/students — Add Student (single).
router.post('/students', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can add a student' });
  const schoolId = req.adminScope.schoolId;
  const {
    firstName, lastName, grade, section, email: emailOverride, initialStatus,
    parentName: parentNameIn, parentEmail: parentEmailInRaw, notes,
    curriculum: curriculumIn, admissionNumber: admissionNumberIn,
  } = req.body || {};
  if (!String(firstName || '').trim() || !String(lastName || '').trim()) return res.status(400).json({ error: 'First and last name are required' });
  if (!grade) return res.status(400).json({ error: 'Grade is required' });

  try {
    const { data: school, error: schoolErr } = await supabase.from('schools').select('name, curriculum').eq('id', schoolId).maybeSingle();
    if (schoolErr) throw schoolErr;
    const schoolName = school?.name || 'School';
    const schoolCurriculum = String(curriculumIn || '').trim() || resolveCurriculum(school?.curriculum, grade);
    const name = toTitleCase(`${firstName.trim()} ${lastName.trim()}`);
    const studentEmailProvided = String(emailOverride || '').trim().toLowerCase();
    const email = studentEmailProvided || generateStudentEmail(name, schoolName);
    const password = generateSecurePassword();

    const { data: dup } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (dup) return res.status(409).json({ error: 'A user with this email already exists' });

    const parentName = String(parentNameIn || '').trim();
    const parentEmailIn = String(parentEmailInRaw || '').trim().toLowerCase();
    if (parentName && parentEmailIn) {
      const { data: existing } = await supabase.from('users').select('id, role').eq('email', parentEmailIn).maybeSingle();
      if (existing && existing.role !== 'parent') {
        return res.status(400).json({ error: `Parent email ${parentEmailIn} already belongs to a non-parent account` });
      }
    }

    const admissionNumberTrimmed = String(admissionNumberIn || '').trim();
    if (admissionNumberTrimmed) {
      const { data: admDup } = await supabase.from('users').select('id')
        .eq('school_id', schoolId).eq('role', 'student').eq('admission_number', admissionNumberTrimmed).maybeSingle();
      if (admDup) return res.status(409).json({ error: `Admission number "${admissionNumberTrimmed}" is already in use` });
    }
    const { count } = await supabase.from('users').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('role', 'student');
    const admissionNumber = admissionNumberTrimmed || generateAdmissionNumber(schoolName, count || 0);

    const firebaseUid = await createFirebaseAccount(email, password);
    const userId = randomUUID();
    const { error: userErr } = await supabase.from('users').insert({
      id: userId, name, email, role: 'student',
      grade, section: section || null, school: schoolName, school_id: schoolId, curriculum: schoolCurriculum,
      admission_number: admissionNumber, status: 'active', onboarding_complete: true,
      admin_notes: notes?.trim() || null,
    });
    if (userErr) throw userErr;

    await supabase.from('student_stats').insert({ student_id: userId });
    const mustChangePassword = initialStatus !== 'active';
    await supabase.from('user_preferences').upsert({
      user_email: email,
      data: { loginId: email, initialPassword: password, studentName: name, grade, section: section || null, school: schoolName, firebaseUid, mustChangePassword, accountStatus: 'active' },
    });

    let resolvedParentEmail = '';
    let newParentCreds = null;
    let parentEmailForLink = '';
    if (parentName) {
      let parentEmail = parentEmailIn;
      let parentUser = null;
      if (parentEmail) {
        const { data: existing } = await supabase.from('users').select('id, email, role').eq('email', parentEmail).maybeSingle();
        if (existing && existing.role === 'parent') {
          parentUser = existing;
        } else if (existing) {
          return res.status(400).json({ error: `Parent email ${parentEmail} already belongs to a non-parent account` });
        }
      }
      if (!parentUser) {
        if (!parentEmail) parentEmail = await generateParentLoginId(supabase);
        const pName = toTitleCase(parentName);
        const pPassword = generateSecurePassword();
        const pFirebaseUid = await createFirebaseAccount(parentEmail, pPassword);
        const parentUserId = randomUUID();
        const { error: pErr } = await supabase.from('users').insert({
          id: parentUserId, name: pName, email: parentEmail, role: 'parent',
          school: schoolName, school_id: schoolId, status: 'active', onboarding_complete: true,
        });
        if (pErr) throw pErr;
        await supabase.from('user_preferences').upsert({
          user_email: parentEmail,
          data: { loginId: parentEmail, initialPassword: pPassword, parentName: pName, school: schoolName, firebaseUid: pFirebaseUid, mustChangePassword: true, accountStatus: 'active' },
        });
        if (parentEmailIn) newParentCreds = { name: pName, email: parentEmail, password: pPassword };
      }
      parentEmailForLink = parentEmail;
      if (parentEmailIn) resolvedParentEmail = parentEmail;
    }

    if (parentEmailForLink) {
      const { data: link } = await supabase.from('parent_children')
        .select('child_id').eq('parent_email', parentEmailForLink).eq('child_id', userId).maybeSingle();
      if (!link) {
        await supabase.from('parent_children').insert({ parent_email: parentEmailForLink, child_id: userId });
      }
    }

    if (studentEmailProvided) {
      await sendCredentialsEmail({ to: email, childName: name, loginId: email, password, childEmail: email });
    } else if (resolvedParentEmail) {
      await sendCredentialsEmail({ to: resolvedParentEmail, childName: name, loginId: email, password, childEmail: email });
    }
    if (newParentCreds) {
      await sendOwnAccountCredentialsEmail({ to: newParentCreds.email, name: newParentCreds.name, loginId: newParentCreds.email, password: newParentCreds.password, role: 'parent' });
    }

    res.status(201).json({
      id: userId, name, email, password, admissionNumber, grade, section: section || null,
      status: mustChangePassword ? 'invited' : 'active',
      parent: newParentCreds ? { name: newParentCreds.name, email: newParentCreds.email, password: newParentCreds.password } : undefined,
    });
  } catch (err) {
    console.error('[POST /school-admin/students] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to create student' });
  }
});

async function assertOwnedStudents(ids, schoolId) {
  const { data, error } = await supabase.from('users').select('id, curriculum').in('id', ids).eq('school_id', schoolId).eq('role', 'student');
  if (error) throw error;
  const rows = data || [];
  const owned = new Set(rows.map((r) => r.id));
  return { owned: ids.filter((id) => owned.has(id)), skipped: ids.filter((id) => !owned.has(id)), rows };
}

// PATCH /school-admin/students/:id/status  { adminEmail, status: 'active'|'inactive'|'archived' }
router.patch('/students/:id/status', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can update students' });
  const { status } = req.body || {};
  if (!['active', 'inactive', 'archived'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const { owned } = await assertOwnedStudents([req.params.id], req.adminScope.schoolId);
    if (!owned.length) return res.status(403).json({ error: 'Not authorized to manage this student' });
    const { error } = await supabase.from('users').update({ status }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[PATCH /school-admin/students/:id/status] error:', err.message);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// PATCH /school-admin/students/:id — edit an existing student's details.
router.patch('/students/:id', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can update students' });
  const schoolId = req.adminScope.schoolId;
  const { name, grade, section, admissionNumber, curriculum, parentName, parentPhone } = req.body || {};
  try {
    const { owned, rows } = await assertOwnedStudents([req.params.id], schoolId);
    if (!owned.length) return res.status(403).json({ error: 'Not authorized to manage this student' });

    const patch = {};
    if (name !== undefined) {
      const trimmed = toTitleCase(String(name).trim());
      if (!trimmed) return res.status(400).json({ error: 'Student name cannot be empty' });
      patch.name = trimmed;
    }
    if (grade !== undefined) patch.grade = String(grade).trim() || null;
    if (section !== undefined) patch.section = String(section).trim() || null;
    if (curriculum !== undefined) patch.curriculum = String(curriculum).trim() || null;
    else if (patch.grade) {
      const { data: school } = await supabase.from('schools').select('curriculum').eq('id', schoolId).maybeSingle();
      const derived = derivedCurriculum(school?.curriculum, rows[0]?.curriculum, patch.grade);
      if (derived) patch.curriculum = derived;
    }
    if (admissionNumber !== undefined) {
      const adm = String(admissionNumber).trim();
      if (adm) {
        const { data: clash } = await supabase.from('users')
          .select('id').eq('school_id', schoolId).eq('role', 'student').eq('admission_number', adm)
          .neq('id', req.params.id).maybeSingle();
        if (clash) return res.status(409).json({ error: `Admission No "${adm}" is already used by another student` });
      }
      patch.admission_number = adm || null;
    }

    if (Object.keys(patch).length) {
      const { error: upErr } = await supabase.from('users').update(patch).eq('id', req.params.id);
      if (upErr) throw upErr;
    }

    if (parentName !== undefined || parentPhone !== undefined) {
      const { data: links } = await supabase.from('parent_children').select('parent_email').eq('child_id', req.params.id);
      const parentEmail = links?.[0]?.parent_email;
      if (parentEmail) {
        const pPatch = {};
        if (parentName !== undefined && String(parentName).trim()) pPatch.name = toTitleCase(String(parentName).trim());
        if (parentPhone !== undefined) pPatch.phone = String(parentPhone).trim() || null;
        if (Object.keys(pPatch).length) {
          await supabase.from('users').update(pPatch).eq('email', parentEmail).eq('role', 'parent');
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[PATCH /school-admin/students/:id] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to update student' });
  }
});

// DELETE /school-admin/students/:id — hard delete (distinct from Archive).
async function deleteStudentRows(userId, email) {
  const delById = async (table, column) => {
    try { await supabase.from(table).delete().eq(column, userId); }
    catch (e) { console.warn(`[delete student] ${table}.${column}: ${e.message}`); }
  };
  const delByEmail = async (table, column, val) => {
    try { await supabase.from(table).delete().eq(column, val); }
    catch (e) { console.warn(`[delete student] ${table}.${column}: ${e.message}`); }
  };
  await delById('assignment_submissions', 'student_id');
  await delById('assignments', 'student_id');
  await delById('challenge_assignments', 'student_id');
  await delById('topic_attempts', 'student_id');
  await delById('messages', 'student_id');
  await delById('student_daily_log', 'student_id');
  await delById('student_stats', 'student_id');
  await delById('student_subject_time', 'student_id');
  await delById('parent_daily_tasks', 'child_id');
  await delById('parent_children', 'child_id');
  await delById('teacher_student', 'student_id');
  await delById('teacher_students', 'student_id');
  if (email) {
    await delByEmail('user_preferences', 'user_email', email);
    await delByEmail('student_preferences', 'user_email', email);
  }
}

async function deleteFirebaseAccountByEmail(email) {
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) return; // no credential configured — skip silently
    const fbUser = await admin.auth().getUserByEmail(email);
    await admin.auth().deleteUser(fbUser.uid);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') console.warn(`[delete student] firebase auth: ${err.message}`);
  }
}

router.delete('/students/:id', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can delete students' });
  const schoolId = req.adminScope.schoolId;
  try {
    const { data: student } = await supabase.from('users')
      .select('id, email').eq('id', req.params.id).eq('school_id', schoolId).eq('role', 'student').maybeSingle();
    if (!student) return res.status(404).json({ error: 'Student not found' });

    await deleteStudentRows(student.id, student.email);
    const { error: delErr } = await supabase.from('users').delete().eq('id', student.id);
    if (delErr) throw delErr;
    await deleteFirebaseAccountByEmail(student.email);

    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /school-admin/students/:id] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to delete student' });
  }
});

// POST /school-admin/students/bulk-status  { adminEmail, studentIds: [], status }
router.post('/students/bulk-status', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can update students' });
  const { studentIds, status } = req.body || {};
  if (!Array.isArray(studentIds) || !studentIds.length) return res.status(400).json({ error: 'studentIds required' });
  if (!['active', 'inactive', 'archived'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const { owned, skipped } = await assertOwnedStudents(studentIds, req.adminScope.schoolId);
    if (owned.length) {
      const { error } = await supabase.from('users').update({ status }).in('id', owned);
      if (error) throw error;
    }
    res.json({ updated: owned.length, skipped });
  } catch (err) {
    console.error('[POST /school-admin/students/bulk-status] error:', err.message);
    res.status(500).json({ error: 'Failed to update students' });
  }
});

// POST /school-admin/students/bulk-grade  { adminEmail, studentIds: [], grade, section? }
router.post('/students/bulk-grade', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can promote students' });
  const { studentIds, grade, section } = req.body || {};
  if (!Array.isArray(studentIds) || !studentIds.length) return res.status(400).json({ error: 'studentIds required' });
  const targetGrade = String(grade || '').trim();
  if (!targetGrade) return res.status(400).json({ error: 'Target grade required' });
  try {
    const { owned, skipped, rows } = await assertOwnedStudents(studentIds, req.adminScope.schoolId);
    if (owned.length) {
      const base = { grade: targetGrade };
      if (section !== undefined) base.section = String(section || '').trim() || null;
      const { data: school } = await supabase.from('schools').select('curriculum').eq('id', req.adminScope.schoolId).maybeSingle();
      const groups = new Map();
      for (const r of rows) {
        const c = derivedCurriculum(school?.curriculum, r.curriculum, targetGrade);
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push(r.id);
      }
      for (const [c, ids] of groups) {
        const { error } = await supabase.from('users').update(c ? { ...base, curriculum: c } : base).in('id', ids);
        if (error) throw error;
      }
    }
    res.json({ promoted: owned.length, skipped, grade: targetGrade, section: section !== undefined ? (String(section || '').trim() || null) : undefined });
  } catch (err) {
    console.error('[POST /school-admin/students/bulk-grade] error:', err.message);
    res.status(500).json({ error: 'Failed to promote students' });
  }
});

async function logImportRun({ schoolId, type, fileName, runByEmail, importedCount, skippedCount }) {
  const status = skippedCount === 0 ? 'Completed' : (importedCount > 0 ? 'Completed with errors' : 'Failed');
  try {
    await supabase.from('import_runs').insert({
      school_id: schoolId, type, file_name: fileName || 'import.csv', run_by_email: runByEmail,
      imported_count: importedCount, skipped_count: skippedCount, status,
    });
  } catch (err) {
    console.error('[logImportRun] failed to record import run:', err.message);
  }
}

// POST /school-admin/students/bulk — upsert students (+ optional linked
// parents) from an edited CSV. Each row is isolated: a failing row is
// reported in `errors` and never aborts the batch.
router.post('/students/bulk', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can bulk import students' });
  const schoolId = req.adminScope.schoolId;
  const { rows, fileName } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows must be a non-empty array' });

  try {
    const { data: school, error: schoolErr } = await supabase.from('schools').select('name, curriculum').eq('id', schoolId).maybeSingle();
    if (schoolErr) throw schoolErr;
    const schoolName = school?.name || 'School';
    const schoolBaseCurriculum = school?.curriculum || null;

    const { count: initialCount } = await supabase.from('users')
      .select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('role', 'student');
    let studentCount = initialCount || 0;

    const created = [];
    const updated = [];
    const skipped = [];
    const errors = [];
    const credentials = [];

    const classTeacherIdByGradeSection = new Map();
    try {
      const grades = await buildGradesSectionsView(schoolId);
      const teacherEmails = new Set();
      for (const g of grades) {
        for (const s of g.sections || []) {
          if (s.classTeacherEmail) teacherEmails.add(s.classTeacherEmail);
        }
      }
      if (teacherEmails.size) {
        const { data: teachers } = await supabase.from('users')
          .select('id, email').in('email', [...teacherEmails]).eq('role', 'teacher').eq('school_id', schoolId);
        const teacherIdByEmail = new Map((teachers || []).map((t) => [t.email, t.id]));
        for (const g of grades) {
          for (const s of g.sections || []) {
            const teacherId = s.classTeacherEmail ? teacherIdByEmail.get(s.classTeacherEmail) : null;
            if (teacherId) classTeacherIdByGradeSection.set(`${g.name}||${s.name}`, teacherId);
          }
        }
      }
    } catch (linkPreloadErr) {
      console.error('[POST /school-admin/students/bulk] class-teacher preload failed:', linkPreloadErr.message);
    }

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i] || {};
      const studentName = String(raw.studentName || '').trim();
      const studentEmail = String(raw.studentEmail || '').trim().toLowerCase();
      const admissionNo = String(raw.admissionNo || '').trim();
      const rowCurriculum = String(raw.curriculum || '').trim();
      const grade = String(raw.grade || '').trim();
      const section = String(raw.section || '').trim();
      const parentName = String(raw.parentName || '').trim();
      const parentEmailIn = String(raw.parentEmail || '').trim().toLowerCase();
      const parentPhone = String(raw.parentPhone || '').trim();

      try {
        if (!studentName) {
          errors.push({ row: i + 1, error: 'Student Name is required' });
          continue;
        }

        let student = null;
        if (studentEmail) {
          const { data: match } = await supabase.from('users')
            .select('id, name, email, grade, section')
            .eq('email', studentEmail).eq('school_id', schoolId).eq('role', 'student').maybeSingle();
          if (match) student = match;
        }
        if (!student && admissionNo) {
          const { data: match } = await supabase.from('users')
            .select('id, name, email, grade, section')
            .eq('admission_number', admissionNo).eq('school_id', schoolId).eq('role', 'student').maybeSingle();
          if (match) student = match;
        }

        let studentUserId;
        const name = toTitleCase(studentName);
        let newStudentCreds = null;

        if (student) {
          skipped.push({ row: i + 1, name, email: student.email, reason: 'Student already exists' });
          continue;
        } else {
          const email = studentEmail || generateStudentEmail(name, schoolName);
          const { data: dup } = await supabase.from('users').select('id, school_id').eq('email', email).maybeSingle();
          if (dup) {
            errors.push({ row: i + 1, error: 'Email already exists' });
            continue;
          }
          const password = generateSecurePassword();
          const admissionNumber = admissionNo || generateAdmissionNumber(schoolName, studentCount++);
          const firebaseUid = await createFirebaseAccount(email, password);
          studentUserId = randomUUID();
          const { error: userErr } = await supabase.from('users').insert({
            id: studentUserId, name, email, role: 'student',
            grade: grade || null, section: section || null, school: schoolName, school_id: schoolId, curriculum: rowCurriculum || resolveCurriculum(schoolBaseCurriculum, grade),
            admission_number: admissionNumber, status: 'active', onboarding_complete: true,
          });
          if (userErr) throw userErr;
          await supabase.from('student_stats').insert({ student_id: studentUserId });
          await supabase.from('user_preferences').upsert({
            user_email: email,
            data: { loginId: email, initialPassword: password, studentName: name, grade: grade || null, section: section || null, school: schoolName, firebaseUid, mustChangePassword: true, accountStatus: 'active' },
          });
          created.push({ id: studentUserId, name, email });
          credentials.push({ name, email, password, role: 'student' });
          newStudentCreds = { email, password };

          if (grade && section) {
            const classTeacherId = classTeacherIdByGradeSection.get(`${grade}||${section}`);
            if (classTeacherId) {
              await supabase.from('teacher_student')
                .upsert({ teacher_id: classTeacherId, student_id: studentUserId, subject: 'Homeroom' },
                  { onConflict: 'teacher_id,student_id,subject', ignoreDuplicates: true });
            }
          }
        }

        let resolvedParentEmail = '';
        let newParentCreds = null;
        if (parentName) {
          let parentEmail = parentEmailIn;
          let parentUser = null;
          if (parentEmail) {
            const { data: existing } = await supabase.from('users').select('id, email, role, phone').eq('email', parentEmail).maybeSingle();
            if (existing && existing.role === 'parent') {
              parentUser = existing;
              if (parentPhone && parentPhone !== existing.phone) {
                await supabase.from('users').update({ phone: parentPhone }).eq('id', existing.id);
              }
            } else if (existing) {
              throw new Error(`Parent email ${parentEmail} already belongs to a non-parent account`);
            }
          }
          if (!parentUser) {
            if (!parentEmail) parentEmail = await generateParentLoginId(supabase);
            const pName = toTitleCase(parentName);
            const pPassword = generateSecurePassword();
            const pFirebaseUid = await createFirebaseAccount(parentEmail, pPassword);
            const parentUserId = randomUUID();
            const { error: pErr } = await supabase.from('users').insert({
              id: parentUserId, name: pName, email: parentEmail, role: 'parent',
              phone: parentPhone || null, school: schoolName, school_id: schoolId,
              status: 'active', onboarding_complete: true,
            });
            if (pErr) throw pErr;
            await supabase.from('user_preferences').upsert({
              user_email: parentEmail,
              data: { loginId: parentEmail, initialPassword: pPassword, parentName: pName, school: schoolName, firebaseUid: pFirebaseUid, mustChangePassword: true, accountStatus: 'active' },
            });
            credentials.push({ name: pName, email: parentEmail, password: pPassword, role: 'parent' });
            if (parentEmailIn) newParentCreds = { name: pName, email: parentEmail, password: pPassword };
          }

          const { data: link } = await supabase.from('parent_children')
            .select('child_id').eq('parent_email', parentEmail).eq('child_id', studentUserId).maybeSingle();
          if (!link) {
            await supabase.from('parent_children').insert({ parent_email: parentEmail, child_id: studentUserId });
          }
          if (parentEmailIn) resolvedParentEmail = parentEmail;
        }

        if (newStudentCreds) {
          if (studentEmail) {
            await sendCredentialsEmail({ to: newStudentCreds.email, childName: name, loginId: newStudentCreds.email, password: newStudentCreds.password, childEmail: newStudentCreds.email });
          } else if (resolvedParentEmail) {
            await sendCredentialsEmail({ to: resolvedParentEmail, childName: name, loginId: newStudentCreds.email, password: newStudentCreds.password, childEmail: newStudentCreds.email });
          }
        }
        if (newParentCreds) {
          await sendOwnAccountCredentialsEmail({ to: newParentCreds.email, name: newParentCreds.name, loginId: newParentCreds.email, password: newParentCreds.password, role: 'parent' });
        }
      } catch (rowErr) {
        console.error(`[POST /school-admin/students/bulk] row ${i + 1} error:`, rowErr.message);
        errors.push({ row: i + 1, error: rowErr.message });
      }
    }

    await logImportRun({
      schoolId, type: 'students', fileName, runByEmail: req.adminScope.email,
      importedCount: created.length + updated.length, skippedCount: skipped.length + errors.length,
    });

    res.json({ created: created.length, updated: updated.length, skipped, errors, credentials });
  } catch (err) {
    console.error('[POST /school-admin/students/bulk] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to bulk import students' });
  }
});

module.exports = router;
