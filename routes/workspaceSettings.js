const express = require('express');
const supabase = require('../services/supabase');

const router = express.Router();

function effectiveSchoolId(req) {
  if (req.adminScope.scopeType === 'school') return req.adminScope.schoolId;
  return req.query.schoolId || null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function shapeSchool(row) {
  return { id: row.id, name: row.name, academicYear: row.academic_year || '', contactEmail: row.contact_email || '' };
}

// GET /school-admin/overview — school identity fields for Workspace Settings.
router.get('/overview', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const { data, error } = await supabase
      .from('schools').select('id, name, academic_year, contact_email').eq('id', schoolId).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'School not found' });
    res.json({ school: shapeSchool(data) });
  } catch (err) {
    console.error('[GET /school-admin/overview] error:', err.message);
    res.status(500).json({ error: 'Failed to load workspace overview' });
  }
});

// PATCH /school-admin/workspace-settings — update school name/academic year/contact email.
router.patch('/workspace-settings', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });

  const name = String(req.body?.name || '').trim();
  const academicYear = String(req.body?.academicYear || '').trim();
  const contactEmail = String(req.body?.contactEmail || '').trim();
  if (!name) return res.status(400).json({ error: 'School name is required.' });
  if (contactEmail && !EMAIL_RE.test(contactEmail)) return res.status(400).json({ error: 'Enter a valid contact email, or leave it blank.' });

  try {
    const { data, error } = await supabase
      .from('schools')
      .update({ name, academic_year: academicYear || null, contact_email: contactEmail || null })
      .eq('id', schoolId)
      .select('id, name, academic_year, contact_email')
      .single();
    if (error) throw error;

    // Keep users.school (a display-only, name-keyed column) in sync with a rename.
    // Scoping itself always uses school_id — this is just so name-keyed lookups
    // (e.g. branding logos, keyed by school name) still resolve after a rename.
    await supabase.from('users').update({ school: name }).eq('school_id', schoolId);

    res.json({ school: shapeSchool(data) });
  } catch (err) {
    console.error('[PATCH /school-admin/workspace-settings] error:', err.message);
    res.status(500).json({ error: 'Failed to save workspace settings' });
  }
});

module.exports = router;
