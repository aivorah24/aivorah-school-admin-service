/**
 * Parents — ported from ai-mentor/server/routes/school-admin.js
 * (GET /parents, POST /parents). The studentId/studentIds legacy pick-list
 * params are ported too (still accepted alongside `children`), even though
 * the refactored frontend only sends `children` now — an older caller could
 * still use them.
 */
const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const supabase = require('../services/supabase');
const { generateSecurePassword, toTitleCase } = require('../services/teacherAccounts');
const { generateParentLoginId } = require('../services/parentAccounts');
const { provisionAccount } = require('../services/accountProvisioning');
const { deriveStatusMap, displayStatus } = require('../services/userStatus');

function effectiveSchoolId(req) {
  if (req.adminScope.scopeType === 'school') return req.adminScope.schoolId;
  return req.query.schoolId || null;
}

// Matches each { admissionNumber } or { name, grade, section } entry to exactly
// one student in the school.
async function resolveChildren(schoolId, childEntries) {
  const resolvedIds = [];
  const unresolved = [];
  for (let i = 0; i < childEntries.length; i++) {
    const entry = childEntries[i] || {};
    const admissionNumber = String(entry.admissionNumber || '').trim();
    const name = String(entry.name || '').trim();
    const grade = String(entry.grade || '').trim();
    const section = String(entry.section || '').trim();

    if (!admissionNumber && !name) {
      unresolved.push({ index: i, reason: 'Enter an admission number or a student name.' });
      continue;
    }

    let query = supabase.from('users').select('id, name, grade, section')
      .eq('school_id', schoolId).eq('role', 'student');
    if (admissionNumber) {
      query = query.ilike('admission_number', admissionNumber);
    } else {
      query = query.ilike('name', name);
      if (grade) query = query.eq('grade', grade);
      if (section) query = query.eq('section', section);
    }
    const { data: matches, error: matchErr } = await query;
    if (matchErr) throw matchErr;

    if (!matches || matches.length === 0) {
      unresolved.push({
        index: i,
        reason: admissionNumber
          ? `No student found with admission number "${admissionNumber}".`
          : `No student found named "${name}"${grade ? ` in ${grade}` : ''}${section ? ` · ${section}` : ''}.`,
      });
    } else if (matches.length > 1) {
      unresolved.push({
        index: i,
        reason: `${matches.length} students match "${name || admissionNumber}" — add grade and section to narrow it down.`,
      });
    } else {
      resolvedIds.push(matches[0].id);
    }
  }
  return { resolvedIds, unresolved };
}

router.get('/parents', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const { data: parents, error } = await supabase
      .from('users').select('id, name, email, status, created_at')
      .eq('school_id', schoolId).eq('role', 'parent').order('name');
    if (error) throw error;
    const emails = (parents || []).map((p) => p.email);
    const mustChangeMap = await deriveStatusMap(emails);
    const { data: links } = emails.length
      ? await supabase.from('parent_children').select('parent_email, child_id').in('parent_email', emails)
      : { data: [] };
    const childIds = [...new Set((links || []).map((l) => l.child_id))];
    const { data: children } = childIds.length
      ? await supabase.from('users').select('id, name').in('id', childIds)
      : { data: [] };
    const childNameMap = new Map((children || []).map((c) => [c.id, c.name]));
    const linkedMap = new Map();
    for (const l of links || []) {
      const arr = linkedMap.get(l.parent_email) || [];
      const cname = childNameMap.get(l.child_id);
      if (cname) arr.push(cname);
      linkedMap.set(l.parent_email, arr);
    }

    res.json((parents || []).map((p) => ({
      id: p.id, name: p.name, email: p.email,
      linkedStudents: linkedMap.get(p.email) || [],
      status: displayStatus(p.status, mustChangeMap.get(p.email) ?? true),
      joinedAt: p.created_at,
    })));
  } catch (err) {
    console.error('[GET /parents] error:', err.message);
    res.status(500).json({ error: 'Failed to load parents' });
  }
});

router.post('/parents', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can invite a parent' });
  const schoolId = req.adminScope.schoolId;
  const { firstName, lastName, email: emailOverride, phone, studentId, studentIds, children } = req.body || {};
  if (!String(firstName || '').trim() || !String(lastName || '').trim()) return res.status(400).json({ error: 'First and last name are required' });

  const presetIds = Array.from(new Set([
    ...(Array.isArray(studentIds) ? studentIds : []),
    ...(studentId ? [studentId] : []),
  ].filter(Boolean)));
  const childEntries = Array.isArray(children) ? children : [];

  try {
    const { resolvedIds, unresolved } = await resolveChildren(schoolId, childEntries);
    if (unresolved.length > 0) {
      return res.status(400).json({ error: 'Could not match one or more children to a student record.', unresolved });
    }

    const linkIds = Array.from(new Set([...presetIds, ...resolvedIds]));

    const { data: school, error: schoolErr } = await supabase.from('schools').select('name').eq('id', schoolId).maybeSingle();
    if (schoolErr) throw schoolErr;
    const schoolName = school?.name || 'School';
    const name = toTitleCase(`${firstName.trim()} ${lastName.trim()}`);
    const cleanPhone = String(phone || '').trim() || null;
    const password = generateSecurePassword();

    if (presetIds.length) {
      const { data: matched } = await supabase.from('users').select('id').in('id', presetIds).eq('school_id', schoolId).eq('role', 'student');
      const matchedIds = new Set((matched || []).map((s) => s.id));
      const missing = presetIds.filter((id) => !matchedIds.has(id));
      if (missing.length) return res.status(400).json({ error: 'One or more selected students were not found in your school' });
    }

    const userId = randomUUID();
    const { email, firebaseUid } = await provisionAccount({
      email: emailOverride,
      generate: generateParentLoginId,
      password,
      conflictMessage: 'An account with this email already exists.',
      insertUser: async (loginEmail) => {
        const { error: userErr } = await supabase.from('users').insert({
          id: userId, name, email: loginEmail, role: 'parent', phone: cleanPhone,
          school: schoolName, school_id: schoolId, status: 'active', onboarding_complete: true,
        });
        if (userErr) throw userErr;
      },
    });

    if (linkIds.length) {
      await supabase.from('parent_children').insert(linkIds.map((childId) => ({ parent_email: email, child_id: childId })));
    }

    await supabase.from('user_preferences').upsert({
      user_email: email,
      data: { loginId: email, initialPassword: password, parentName: name, school: schoolName, firebaseUid, mustChangePassword: true, accountStatus: 'active' },
    });

    res.status(201).json({ id: userId, name, email, password, status: 'invited' });
  } catch (err) {
    if (err.code === 'EMAIL_EXISTS') {
      // An existing parent in this school can take the child instead — the
      // frontend offers that via POST /parents/:id/children.
      const e = err.existing;
      if (e && e.role === 'parent' && e.school_id === schoolId) {
        return res.status(409).json({
          error: 'An account with this email already exists. Link this child to the existing parent instead?',
          code: 'EMAIL_EXISTS',
          existingParent: { id: e.id, name: e.name, email: e.email },
        });
      }
      return res.status(409).json({ error: err.message, code: 'EMAIL_EXISTS' });
    }
    console.error('[POST /parents] error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to invite parent' });
  }
});

// POST /school-admin/parents/:id/children — link children to an existing
// parent (the "link instead" path when Add Parent hits an existing email).
router.post('/parents/:id/children', async (req, res) => {
  if (req.adminScope.scopeType !== 'school') return res.status(400).json({ error: 'Only a school administrator can link a parent' });
  const schoolId = req.adminScope.schoolId;
  const childEntries = Array.isArray(req.body?.children) ? req.body.children : [];
  if (!childEntries.length) return res.status(400).json({ error: 'Add at least one child to link' });

  try {
    const { data: parent, error: parentErr } = await supabase.from('users').select('id, name, email')
      .eq('id', req.params.id).eq('school_id', schoolId).eq('role', 'parent').maybeSingle();
    if (parentErr) throw parentErr;
    if (!parent) return res.status(404).json({ error: 'Parent not found in your school' });

    const { resolvedIds, unresolved } = await resolveChildren(schoolId, childEntries);
    if (unresolved.length > 0) {
      return res.status(400).json({ error: 'Could not match one or more children to a student record.', unresolved });
    }

    const { data: existingLinks } = await supabase.from('parent_children').select('child_id')
      .eq('parent_email', parent.email).in('child_id', resolvedIds);
    const already = new Set((existingLinks || []).map((l) => l.child_id));
    const toLink = Array.from(new Set(resolvedIds)).filter((id) => !already.has(id));
    if (toLink.length) {
      const { error: linkErr } = await supabase.from('parent_children')
        .insert(toLink.map((childId) => ({ parent_email: parent.email, child_id: childId })));
      if (linkErr) throw linkErr;
    }

    res.json({ id: parent.id, name: parent.name, email: parent.email, linked: toLink.length });
  } catch (err) {
    console.error('[POST /parents/:id/children] error:', err.message);
    res.status(500).json({ error: 'Failed to link children' });
  }
});

module.exports = router;
