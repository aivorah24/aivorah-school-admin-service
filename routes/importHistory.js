const express = require('express');
const supabase = require('../services/supabase');

const router = express.Router();

function effectiveSchoolId(req) {
  if (req.adminScope.scopeType === 'school') return req.adminScope.schoolId;
  return req.query.schoolId || null;
}

// GET /school-admin/import-history — every past bulk-import run for this school.
router.get('/import-history', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const { data, error } = await supabase
      .from('import_runs')
      .select('id, type, file_name, run_by_email, imported_count, skipped_count, status, created_at')
      .eq('school_id', schoolId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json((data || []).map((r) => ({
      id: r.id, type: r.type, fileName: r.file_name, runByEmail: r.run_by_email,
      importedCount: r.imported_count, skippedCount: r.skipped_count, status: r.status, createdAt: r.created_at,
    })));
  } catch (err) {
    console.error('[GET /school-admin/import-history] error:', err.message);
    res.status(500).json({ error: 'Failed to load import history' });
  }
});

module.exports = router;
