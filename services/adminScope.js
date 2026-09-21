/**
 * Centralized admin scope resolution — the single authorization authority for
 * every school-scoped admin operation in this service.
 *
 * Ported verbatim from ai-mentor/server/services/adminScope.js (the monolith
 * copy remains the source of truth for other school-admin console features
 * not yet migrated — keep both in sync until the full console moves).
 *
 * V1 tenant model: the schools table + users.school_id FK is the tenant
 * boundary. Scope is ALWAYS derived server-side from the users table —
 * client-supplied role/school_id values are never authorization inputs.
 *
 * Scope semantics:
 *   - Allowlisted emails (ADMIN_EMAIL/ADMIN_EMAILS env + hardcoded founders)
 *     and users with role super_admin  → { scopeType: 'global', schoolId: null }
 *   - role school_admin + valid school_id → { scopeType: 'school', schoolId }
 *   - role school_admin + NULL school_id  → REJECTED (403). A null school is a
 *     configuration error, never "all schools".
 *   - anyone else → REJECTED (403).
 */
const supabase = require('./supabase');

function getAllowedAdminEmails() {
  const list = [
    'kannansaimohan2003@gmail.com',
    'preddy6678@gmail.com',
    process.env.ADMIN_EMAIL || '',
    ...(process.env.ADMIN_EMAILS || '').split(','),
  ];
  return new Set(list.map((e) => String(e).toLowerCase().trim()).filter(Boolean));
}

/**
 * Resolves the admin scope for an email.
 * Returns { ok: true, scope: { scopeType, schoolId, email, role } }
 * or      { ok: false, statusCode, error }.
 */
async function resolveAdminScope(rawEmail) {
  const email = String(rawEmail || '').toLowerCase().trim();
  if (!email) return { ok: false, statusCode: 401, error: 'adminEmail required' };

  if (getAllowedAdminEmails().has(email)) {
    return { ok: true, scope: { scopeType: 'global', schoolId: null, email, role: 'allowlist' } };
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('id, role, school_id')
    .eq('email', email)
    .maybeSingle();
  if (error) return { ok: false, statusCode: 500, error: 'Admin lookup failed' };

  if (user?.role === 'super_admin') {
    return { ok: true, scope: { scopeType: 'global', schoolId: null, email, role: 'super_admin' } };
  }
  if (user?.role === 'school_admin') {
    if (!user.school_id) {
      return { ok: false, statusCode: 403, error: 'School administrator is not assigned to a school.' };
    }
    return { ok: true, scope: { scopeType: 'school', schoolId: user.school_id, email, role: 'school_admin' } };
  }
  if (user?.role === 'teacher') {
    if (!user.school_id) {
      return { ok: false, statusCode: 403, error: 'Teacher is not assigned to a school.' };
    }
    // Teachers may only ever reach the parents of their own assigned students —
    // scopeTargets() (announcements route) forces every target row to
    // { schoolId, role: 'parent', teacherId: user.id } regardless of what the
    // client requests.
    return { ok: true, scope: { scopeType: 'teacher', schoolId: user.school_id, email, role: 'teacher', teacherId: user.id } };
  }
  return { ok: false, statusCode: 403, error: 'Not authorized to manage this school' };
}

/**
 * Ownership/management rule for a single announcement (ported verbatim from
 * ai-mentor/server/services/adminScope.js):
 *   - global scope: manages everything.
 *   - school scope: may manage only announcements that are (a) fully scoped to
 *     their school — every target row has school_id === their school, at least
 *     one target row exists (no global announcements) — AND (b) created by an
 *     email that resolves to a school_admin of that same school.
 *   - teacher scope: may manage only announcements it created itself, whose
 *     every target row is exactly { school_id: their school, role: 'parent',
 *     teacher_id: their id }.
 */
async function canManageAnnouncement(scope, announcement, targets) {
  if (scope.scopeType === 'global') return true;

  const rows = targets || [];
  if (rows.length === 0) return false; // global announcement

  if (scope.scopeType === 'teacher') {
    const creatorEmail = String(announcement.created_by || '').toLowerCase().trim();
    if (creatorEmail !== scope.email) return false;
    return rows.every((t) => t.school_id === scope.schoolId && t.role === 'parent' && t.teacher_id === scope.teacherId);
  }

  if (!rows.every((t) => t.school_id === scope.schoolId)) return false; // other/multi-school

  const creatorEmail = String(announcement.created_by || '').toLowerCase().trim();
  if (!creatorEmail) return false;
  if (creatorEmail === scope.email) return true;
  const { data: creator } = await supabase
    .from('users').select('role, school_id').eq('email', creatorEmail).maybeSingle();
  return !!creator && creator.role === 'school_admin' && creator.school_id === scope.schoolId;
}

/**
 * Express middleware wrapper: reads adminEmail from body or query, resolves
 * scope, attaches req.adminScope (and legacy req.adminEmail), or rejects.
 */
function requireAdminScope(req, res, next) {
  const email = req.body?.adminEmail || req.query.adminEmail;
  resolveAdminScope(email)
    .then((result) => {
      if (!result.ok) return res.status(result.statusCode).json({ error: result.error });
      req.adminScope = result.scope;
      req.adminEmail = result.scope.email;
      next();
    })
    .catch((err) => {
      console.error('[adminScope] resolution failed:', err.message);
      res.status(500).json({ error: 'Authorization check failed' });
    });
}

module.exports = { resolveAdminScope, requireAdminScope, canManageAnnouncement, getAllowedAdminEmails };
