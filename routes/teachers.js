/**
 * Teachers — ported from ai-mentor/server/routes/school-admin.js
 * (GET /teachers, POST /teachers, and their normalizeTeaches/deriveStatusMap/
 * displayStatus helpers). Bulk import (/teachers/bulk, /teachers/template.*)
 * intentionally NOT ported — not used by the refactored frontend screens,
 * stays on the monolith for now.
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

module.exports = router;
