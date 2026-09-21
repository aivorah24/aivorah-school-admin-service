require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { requireAdminScope } = require('./services/adminScope');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-school-admin-service' }));

// Applied once here, not per-router — two routers mounted at the same
// '/school-admin' prefix each with their own `router.use(requireAdminScope)`
// means a request whose path only matches the SECOND router still falls
// through the first router's middleware first (Express runs an unscoped
// router.use() for every request that reaches that router, matching route
// or not), so the admin-scope DB lookup ran twice per request. Consolidating
// it here fixes that for every route file mounted below.
app.use('/school-admin', requireAdminScope);

// Mounted at /school-admin so routes keep the exact same paths
// (/school-admin/grades-sections, /school-admin/grades, /school-admin/classes,
// ...) the frontend already calls — no contract change for either migrated
// feature.
app.use('/school-admin', require('./routes/gradesSections'));
app.use('/school-admin', require('./routes/classes'));
app.use('/school-admin', require('./routes/teachers'));
app.use('/school-admin', require('./routes/parents'));
app.use('/school-admin', require('./routes/importHistory'));
app.use('/school-admin', require('./routes/workspaceSettings'));

// Mounted at /announcements, NOT /school-admin — most of its routes (active,
// list, :id, seen, dismiss) are reader-facing and unauthenticated by design;
// only the /admin/* routes need requireAdminScope, applied per-route inside
// the file itself (see routes/announcements.js).
app.use('/announcements', require('./routes/announcements'));

const PORT = process.env.PORT || 3018;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah School Admin service running on http://localhost:${PORT}`);
  });
}

module.exports = app;
