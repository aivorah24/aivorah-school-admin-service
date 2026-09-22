/**
 * School Admin People — read-only roster of everyone linked to the admin's
 * own school (students/teachers/parents/school_admin). GET /school-admin/people
 * never existed anywhere (not the monolith, not any microservice) — the
 * legacy frontend screen was calling a route that always 404'd. Built fresh
 * to match that screen's expected flat { id, name, email, role, grade,
 * joinedAt } shape.
 */
const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

function effectiveSchoolId(req) {
  if (req.adminScope.scopeType === 'school') return req.adminScope.schoolId;
  return req.query.schoolId || null;
}

// GET /school-admin/people?adminEmail=
router.get('/people', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, email, role, grade, created_at')
      .eq('school_id', schoolId)
      .in('role', ['student', 'teacher', 'parent', 'school_admin'])
      .neq('status', 'archived')
      .order('name');
    if (error) throw error;

    res.json((data || []).map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role,
      grade: u.grade || null, joinedAt: u.created_at,
    })));
  } catch (err) {
    console.error('[GET /school-admin/people] error:', err.message);
    res.status(500).json({ error: 'Failed to load people' });
  }
});

module.exports = router;
