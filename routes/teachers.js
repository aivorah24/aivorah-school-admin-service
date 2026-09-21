/**
 * Teachers — ported from ai-mentor/server/routes/school-admin.js
 * (GET /teachers, POST /teachers, /teachers/bulk, /teachers/template.csv|.xlsx,
 * and their normalizeTeaches/deriveStatusMap/displayStatus helpers).
 */
const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const supabase = require('../services/supabase');
const { generateSecurePassword, generateStaffEmail, createFirebaseAccount, toTitleCase } = require('../services/teacherAccounts');
const { sendOwnAccountCredentialsEmail } = require('../services/mailer');
const { deriveStatusMap, displayStatus } = require('../services/userStatus');

function effectiveSchoolId(req) {
  if (req.adminScope.scopeType === 'school') return req.adminScope.schoolId;
  return req.query.schoolId || null;
}

// A school's stored `curriculum` is a BASE type (IB / CBSE / ICSE /
// Cambridge / ...) — IB spans PYP (Grade 1-5) / MYP (Grade 6-10) / DP
// (Grade 11-12), so the exact curriculum is derived per grade.
function resolveCurriculum(baseCurriculum, grade) {
  if (!baseCurriculum) return null;
  if (baseCurriculum !== 'IB') return baseCurriculum;
  const num = parseInt(String(grade || '').replace(/\D/g, ''), 10);
  if (!num) return 'IB PYP';
  if (num <= 5) return 'IB PYP';
  if (num <= 10) return 'IB MYP';
  return 'IB DP';
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

function normalizeTeaches(body) {
  const { teaches, subjects, curriculum, grade } = body || {};
  if (Array.isArray(teaches) && teaches.length > 0) {
    return teaches
      .map((e) => ({
        curriculum: String(e?.curriculum || '').trim(),
        grade: String(e?.grade || '').trim(),
        subjects: Array.isArray(e?.subjects) ? e.subjects.map((s) => String(s).trim()).filter(Boolean) : [],
      }))
      .filter((e) => e.curriculum && e.grade);
  }
  const legacyCurriculum = String(curriculum || '').trim();
  const legacyGrade = String(grade || '').trim();
  if (!legacyCurriculum && !legacyGrade) return [];
  return [{
    curriculum: legacyCurriculum, grade: legacyGrade,
    subjects: Array.isArray(subjects) ? subjects.map((s) => String(s).trim()).filter(Boolean) : [],
  }];
}

router.get('/teachers', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const { data: teachers, error } = await supabase
      .from('users').select('id, name, email, status, created_at, grade, curriculum')
      .eq('school_id', schoolId).eq('role', 'teacher').order('name');
    if (error) throw error;
    const emails = (teachers || []).map((t) => t.email);
    const mustChangeMap = await deriveStatusMap(emails);
    const { data: prefs } = emails.length
      ? await supabase.from('user_preferences').select('user_email, data').in('user_email', emails)
      : { data: [] };
    const teachesMap = new Map((prefs || []).map((p) => [p.user_email, p.data?.teaches || []]));

    res.json((teachers || []).map((t) => {
      const teaches = teachesMap.get(t.email) || [];
      return {
        id: t.id, name: t.name, email: t.email,
        teaches,
        subjects: Array.from(new Set(teaches.flatMap((e) => Array.isArray(e?.subjects) ? e.subjects : []))),
        grade: t.grade || null, curriculum: t.curriculum || null,
        status: displayStatus(t.status, mustChangeMap.get(t.email) ?? true),
        joinedAt: t.created_at,
      };
    }));
  } catch (err) {
    console.error('[GET /teachers] error:', err.message);
    res.status(500).json({ error: 'Failed to load teachers' });
  }
});

router.post('/teachers', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can add a teacher' });
  const schoolId = req.adminScope.schoolId;
  const { firstName, lastName, email: emailOverride } = req.body || {};
  if (!String(firstName || '').trim() || !String(lastName || '').trim()) return res.status(400).json({ error: 'First and last name are required' });
  try {
    const { data: school, error: schoolErr } = await supabase.from('schools').select('name').eq('id', schoolId).maybeSingle();
    if (schoolErr) throw schoolErr;
    const schoolName = school?.name || 'School';
    const name = toTitleCase(`${firstName.trim()} ${lastName.trim()}`);
    const email = String(emailOverride || '').trim().toLowerCase() || generateStaffEmail(name, schoolName, 'teacher');
    const password = generateSecurePassword();
    const teaches = normalizeTeaches(req.body);
    const teachCurriculum = teaches[0]?.curriculum || null;
    const teachGrade = teaches[0]?.grade || null;

    const { data: dup } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (dup) return res.status(409).json({ error: 'A user with this email already exists' });

    const firebaseUid = await createFirebaseAccount(email, password);
    const userId = randomUUID();
    const { error: userErr } = await supabase.from('users').insert({
      id: userId, name, email, role: 'teacher',
      school: schoolName, school_id: schoolId, status: 'active', onboarding_complete: true,
      curriculum: teachCurriculum, grade: teachGrade,
    });
    if (userErr) throw userErr;

    await supabase.from('user_preferences').upsert({
      user_email: email,
      data: { loginId: email, initialPassword: password, teacherName: name, school: schoolName, firebaseUid, teaches, teachCurriculum, teachGrade, mustChangePassword: true, accountStatus: 'active' },
    });

    if (String(emailOverride || '').trim()) {
      await sendOwnAccountCredentialsEmail({ to: email, name, loginId: email, password, role: 'teacher' });
    }

    const allSubjects = Array.from(new Set(teaches.flatMap((e) => e.subjects)));
    res.status(201).json({ id: userId, name, email, password, teaches, subjects: allSubjects, status: 'invited' });
  } catch (err) {
    console.error('[POST /teachers] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to add teacher' });
  }
});

// ── Teacher bulk import: template + upsert-by-create ────────────────────────
const TEACHER_TEMPLATE_HEADER = ['Teacher Name', 'Email', 'Curriculum', 'Grade', 'Subjects', 'Phone'];
const TEACHER_SAMPLE_ROW_COUNT = 4;
function buildTeacherSampleRows(baseCurriculum) {
  const c1 = resolveCurriculum(baseCurriculum, 'Grade 1') || '';
  const c3 = resolveCurriculum(baseCurriculum, 'Grade 3') || '';
  const c4 = resolveCurriculum(baseCurriculum, 'Grade 4') || '';
  const c5 = resolveCurriculum(baseCurriculum, 'Grade 5') || '';
  return [
    // A teacher who handles more than one grade — recommended pattern: ONE
    // row, "|" separating each grade's Curriculum/Grade/Subjects, matched by
    // position. Works even when Email is left blank (the normal case).
    ['Mayur Sample (delete before uploading)', '', `${c1} | ${c3}`, 'Grade 1 | Grade 3', 'Social Studies | Maths', ''],
    // Alternative: same Email repeated on more than one row also merges into
    // ONE account — but only use this if you're supplying a real, exact-match
    // Email on every row for that teacher.
    ['Priya Sample (delete before uploading)', 'priya.sample@example.com', c3, 'Grade 3', 'Maths; Science', '+91 90000 00001'],
    ['Priya Sample (delete before uploading)', 'priya.sample@example.com', c4, 'Grade 4', 'Social Studies', '+91 90000 00001'],
    ['Rahul Sample (delete before uploading)', '', c5, 'Grade 5', 'English', ''],
  ];
}

async function buildTeacherTemplateRows(schoolId) {
  const { data: school } = await supabase.from('schools').select('curriculum').eq('id', schoolId).maybeSingle();
  const sampleRows = buildTeacherSampleRows(school?.curriculum || null);

  const { data: teachers, error } = await supabase
    .from('users').select('name, email, phone, grade, curriculum').eq('school_id', schoolId).eq('role', 'teacher').order('name');
  if (error) throw error;
  const emails = (teachers || []).map((t) => t.email);
  const { data: prefs } = emails.length
    ? await supabase.from('user_preferences').select('user_email, data').in('user_email', emails)
    : { data: [] };
  const teachesMap = new Map((prefs || []).map((p) => [p.user_email, (p.data?.teaches || [])]));
  const realRows = (teachers || []).map((t) => {
    const teaches = teachesMap.get(t.email) || [];
    const subjectsCsv = Array.from(new Set(teaches.flatMap((e) => Array.isArray(e?.subjects) ? e.subjects : []))).join('; ');
    return [t.name || '', t.email || '', t.curriculum || '', t.grade || '', subjectsCsv, t.phone || ''];
  });
  return [...sampleRows, ...realRows];
}

router.get('/teachers/template.csv', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const rows = await buildTeacherTemplateRows(schoolId);
    const csv = toCsv(TEACHER_TEMPLATE_HEADER, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="teachers_template.csv"');
    res.send(csv);
  } catch (err) {
    console.error('[GET /school-admin/teachers/template.csv] error:', err.message);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

router.get('/teachers/template.xlsx', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const rows = await buildTeacherTemplateRows(schoolId);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Aivorah';
    const ws = wb.addWorksheet('Teachers', { views: [{ state: 'frozen', ySplit: 1 }] });
    const widths = [30, 30, 12, 12, 26, 18];
    ws.columns = TEACHER_TEMPLATE_HEADER.map((header, i) => ({ header, key: `c${i}`, width: widths[i] || 18 }));
    const THIN = { style: 'thin', color: { argb: 'FFD9D3C7' } };
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5C4A1E' } };
      cell.border = { top: THIN, left: THIN, right: THIN, bottom: THIN };
    });
    ws.getRow(1).height = 22;
    const TCH_PHONE_COL = TEACHER_TEMPLATE_HEADER.indexOf('Phone') + 1;
    if (TCH_PHONE_COL > 0) ws.getColumn(TCH_PHONE_COL).numFmt = '@';
    rows.forEach((rowValues, i) => {
      const row = ws.addRow(rowValues);
      const isSample = i < TEACHER_SAMPLE_ROW_COUNT;
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = { top: THIN, left: THIN, right: THIN, bottom: THIN };
        if (isSample) { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBF0DA' } }; cell.font = { italic: true, color: { argb: 'FF8A7550' } }; }
      });
      if (TCH_PHONE_COL > 0) {
        const pc = row.getCell(TCH_PHONE_COL);
        pc.numFmt = '@';
        if (pc.value != null) pc.value = String(pc.value);
      }
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: TEACHER_TEMPLATE_HEADER.length } };
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="teachers_template.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[GET /school-admin/teachers/template.xlsx] error:', err.message);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

// A teacher can teach different subjects in different grades (e.g. Social
// Studies in Grade 3, Science in Grade 4). Recommended pattern: a SINGLE row
// with "|"-separated groups in Grade and Subjects, matched by position.
// Group counts across Grade/Subjects must match exactly (a single Curriculum
// group is allowed to apply to every grade) — a mismatch is rejected as a
// row error rather than silently mis-pairing or dropping data.
function parseRowTeachingEntries(rowCurriculum, rowGrade, rowSubjectsRaw, schoolBaseCurriculumForTeachers) {
  const grades = String(rowGrade || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (grades.length === 0) return { entries: [], error: null };
  const curricula = String(rowCurriculum || '').split('|').map((s) => s.trim()).filter(Boolean);
  const subjectGroups = String(rowSubjectsRaw || '').split('|').map((s) => s.trim());
  if (grades.length > 1) {
    if (subjectGroups.length !== grades.length) {
      return { entries: [], error: `Grade has ${grades.length} "|"-separated groups but Subjects has ${subjectGroups.length} — they must match one-to-one` };
    }
    if (curricula.length > 1 && curricula.length !== grades.length) {
      return { entries: [], error: `Grade has ${grades.length} "|"-separated groups but Curriculum has ${curricula.length} — use one Curriculum for all grades, or one per grade` };
    }
  }
  const entries = grades.map((grade, i) => {
    const curriculum = curricula[i] || curricula[0] || resolveCurriculum(schoolBaseCurriculumForTeachers, grade) || '';
    const subjects = (subjectGroups[i] || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    return { curriculum, grade, subjects };
  }).filter((e) => e.curriculum && e.grade);
  return { entries, error: null };
}

// POST /school-admin/teachers/bulk — create teacher accounts from parsed rows.
// Body: { rows: [{ teacherName, email, curriculum, grade, subjects, phone }] }.
router.post('/teachers/bulk', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can bulk import teachers' });
  const schoolId = req.adminScope.schoolId;
  const { rows, fileName } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows must be a non-empty array' });
  try {
    const { data: school } = await supabase.from('schools').select('name, curriculum').eq('id', schoolId).maybeSingle();
    const schoolName = school?.name || 'School';
    const schoolBaseCurriculumForTeachers = school?.curriculum || null;
    const errors = [];
    const teacherByEmail = new Map(); // email -> record, for merging same-email rows within this batch
    const createdRecords = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i] || {};
      const teacherName = String(raw.teacherName || '').trim();
      const emailIn = String(raw.email || '').trim().toLowerCase();
      const phone = String(raw.phone || '').trim();
      const rowCurriculum = String(raw.curriculum || '').trim();
      const rowSubjectsRaw = Array.isArray(raw.subjects) ? raw.subjects.join(', ') : String(raw.subjects || '');
      const { entries: rowEntries, error: groupError } = parseRowTeachingEntries(rowCurriculum, raw.grade, rowSubjectsRaw, schoolBaseCurriculumForTeachers);
      try {
        if (!teacherName) { errors.push({ row: i + 1, error: 'Teacher Name is required' }); continue; }
        if (groupError) { errors.push({ row: i + 1, error: groupError }); continue; }
        const name = toTitleCase(teacherName);
        const teachCurriculum = rowEntries[0]?.curriculum || null;
        const teachGrade = rowEntries[0]?.grade || null;

        if (emailIn && teacherByEmail.has(emailIn)) {
          teacherByEmail.get(emailIn).teaches.push(...rowEntries);
          continue;
        }

        const email = emailIn || generateStaffEmail(name, schoolName, 'teacher');
        const { data: dup } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
        if (dup) { errors.push({ row: i + 1, error: 'Email already exists' }); continue; }
        const password = generateSecurePassword();
        const firebaseUid = await createFirebaseAccount(email, password);
        const userId = randomUUID();
        const { error: userErr } = await supabase.from('users').insert({
          id: userId, name, email, role: 'teacher', phone: phone || null,
          school: schoolName, school_id: schoolId, status: 'active', onboarding_complete: true,
          curriculum: teachCurriculum, grade: teachGrade,
        });
        if (userErr) throw userErr;
        const record = { userId, name, email, password, firebaseUid, teachCurriculum, teachGrade, teaches: [...rowEntries], sendEmail: !!emailIn };
        createdRecords.push(record);
        if (emailIn) teacherByEmail.set(emailIn, record);
      } catch (rowErr) {
        console.error(`[POST /school-admin/teachers/bulk] row ${i + 1} error:`, rowErr.message);
        errors.push({ row: i + 1, error: rowErr.message });
      }
    }

    // Persist prefs + send credentials once per created teacher, after every
    // row has been folded in (so multi-grade merges are complete first).
    const credentials = [];
    for (const rec of createdRecords) {
      await supabase.from('user_preferences').upsert({
        user_email: rec.email,
        data: { loginId: rec.email, initialPassword: rec.password, teacherName: rec.name, school: schoolName, firebaseUid: rec.firebaseUid, teaches: rec.teaches, teachCurriculum: rec.teachCurriculum, teachGrade: rec.teachGrade, mustChangePassword: true, accountStatus: 'active' },
      });
      credentials.push({ name: rec.name, email: rec.email, password: rec.password, role: 'teacher' });
      if (rec.sendEmail) await sendOwnAccountCredentialsEmail({ to: rec.email, name: rec.name, loginId: rec.email, password: rec.password, role: 'teacher' });
    }
    await logImportRun({
      schoolId, type: 'teachers', fileName, runByEmail: req.adminScope.email,
      importedCount: createdRecords.length, skippedCount: errors.length,
    });

    res.json({ created: createdRecords.length, updated: 0, errors, credentials });
  } catch (err) {
    console.error('[POST /school-admin/teachers/bulk] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to bulk import teachers' });
  }
});

module.exports = router;
