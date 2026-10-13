/**
 * School Policies & Resources — a browsable folder/file library (PDFs,
 * handbooks) scoped by school + program/grade. Ported verbatim from
 * ai-mentor/server/routes/resources.js.
 *   • Teachers / school admins: full manage (create folders, upload, delete).
 *   • Parents: read-only (their child's-school + grade/program-scoped items).
 *   • Students: never routed here.
 * Identity is always re-derived server-side (services/classAccess.getUserContext).
 * Mounted at /resources, NOT /school-admin — readable by teachers and
 * parents, not just admin-scoped users, so it must bypass this service's
 * router-level requireAdminScope middleware (see index.js).
 */
const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { getUserContext } = require('../services/classAccess');
const { normalizeCurriculum, curriculumAliases } = require('../services/curriculum');

const MANAGER_ROLES = ['teacher', 'school_admin', 'super_admin'];

// The scopes a viewer may see. Managers see everything in their school (null =
// no scope filter). Parents/students see 'school' + their (children's) grade
// and curriculum/program.
async function visibleScopes(userCtx) {
  if (MANAGER_ROLES.includes(userCtx.role)) return null; // all
  const scopes = new Set(['school']);
  if (userCtx.grade) scopes.add(userCtx.grade);
  if (userCtx.curriculum) curriculumAliases(userCtx.curriculum).forEach((c) => scopes.add(c));
  if (userCtx.role === 'parent') {
    const { data: kids } = await supabase
      .from('parent_children')
      .select('users!parent_children_child_id_fkey(grade, curriculum)')
      .eq('parent_email', userCtx.email);
    for (const k of kids || []) {
      if (k.users?.grade) scopes.add(k.users.grade);
      if (k.users?.curriculum) curriculumAliases(k.users.curriculum).forEach((c) => scopes.add(c));
    }
  }
  return [...scopes];
}

// Resolve author emails → display names (best-effort).
async function nameMap(emails) {
  const distinct = [...new Set(emails.filter(Boolean))];
  const map = new Map();
  if (!distinct.length) return map;
  const { data } = await supabase.from('users').select('email, name').in('email', distinct);
  for (const u of data || []) map.set(u.email, u.name);
  return map;
}

function inScope(scope, allowed) {
  if (allowed === null) return true;          // manager sees all
  return scope === 'school' || allowed.includes(scope);
}

// Build breadcrumb from a folder up to the root.
async function breadcrumb(schoolId, folderId) {
  const trail = [];
  let id = folderId;
  const guard = 20;
  for (let i = 0; id && i < guard; i++) {
    const { data: f } = await supabase
      .from('resource_folders').select('id, name, parent_folder_id')
      .eq('id', id).eq('school_id', schoolId).maybeSingle();
    if (!f) break;
    trail.unshift({ id: f.id, name: f.name });
    id = f.parent_folder_id;
  }
  return trail;
}

// GET /resources?email=&folderId=
router.get('/', async (req, res) => {
  try {
    const userCtx = await getUserContext(req.query.email);
    if (!userCtx) return res.status(401).json({ error: 'Unknown user' });
    if (!userCtx.school_id) return res.json({ folders: [], files: [], breadcrumb: [], canManage: false, scopeLabel: null });

    const schoolId = userCtx.school_id;
    const folderId = req.query.folderId || null;
    const allowed = await visibleScopes(userCtx);
    const canManage = MANAGER_ROLES.includes(userCtx.role);

    // Folders directly under folderId (or root).
    let folderQ = supabase.from('resource_folders')
      .select('id, name, scope, created_by, updated_at')
      .eq('school_id', schoolId).order('name');
    folderQ = folderId ? folderQ.eq('parent_folder_id', folderId) : folderQ.is('parent_folder_id', null);
    const { data: folders, error: fErr } = await folderQ;
    if (fErr) throw fErr;

    // Files in folderId (or root).
    let fileQ = supabase.from('resource_files')
      .select('id, title, file_url, file_type, file_size, scope, uploaded_by, updated_at')
      .eq('school_id', schoolId).order('title');
    fileQ = folderId ? fileQ.eq('folder_id', folderId) : fileQ.is('folder_id', null);
    const { data: files, error: flErr } = await fileQ;
    if (flErr) throw flErr;

    const visFolders = (folders || []).filter((f) => inScope(f.scope, allowed));
    const visFiles = (files || []).filter((f) => inScope(f.scope, allowed));
    const names = await nameMap([...visFolders.map((f) => f.created_by), ...visFiles.map((f) => f.uploaded_by)]);

    res.json({
      canManage,
      scopeLabel: normalizeCurriculum(userCtx.curriculum) || null,
      breadcrumb: await breadcrumb(schoolId, folderId),
      folders: visFolders.map((f) => ({
        id: f.id, name: f.name, scope: f.scope,
        author: names.get(f.created_by) || f.created_by, updatedAt: f.updated_at,
      })),
      files: visFiles.map((f) => ({
        id: f.id, title: f.title, fileUrl: f.file_url, fileType: f.file_type,
        fileSize: f.file_size, scope: f.scope,
        author: names.get(f.uploaded_by) || f.uploaded_by, updatedAt: f.updated_at,
      })),
    });
  } catch (err) {
    console.error('[GET /resources] error:', err.message);
    res.status(500).json({ error: 'Failed to load resources' });
  }
});

async function requireManager(email) {
  const userCtx = await getUserContext(email);
  if (!userCtx || !userCtx.school_id) return { ok: false, code: 401, error: 'Unknown user' };
  if (!MANAGER_ROLES.includes(userCtx.role)) return { ok: false, code: 403, error: 'Only teachers and school admins can manage resources' };
  return { ok: true, userCtx };
}

// POST /resources/folder { email, name, parentFolderId?, scope? }
router.post('/folder', async (req, res) => {
  const { email, name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Folder name is required' });
  const gate = await requireManager(email);
  if (!gate.ok) return res.status(gate.code).json({ error: gate.error });
  try {
    const { data, error } = await supabase.from('resource_folders').insert({
      school_id: gate.userCtx.school_id,
      parent_folder_id: req.body.parentFolderId || null,
      name: String(name).trim(),
      scope: req.body.scope ? normalizeCurriculum(req.body.scope) : 'school',
      created_by: gate.userCtx.email,
    }).select('id').single();
    if (error) throw error;
    res.status(201).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('[POST /resources/folder] error:', err.message);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// POST /resources/file { email, folderId?, title, fileUrl, fileType?, fileSize?, scope? }
router.post('/file', async (req, res) => {
  const { email, title, fileUrl } = req.body || {};
  if (!title || !fileUrl) return res.status(400).json({ error: 'title and fileUrl are required' });
  const gate = await requireManager(email);
  if (!gate.ok) return res.status(gate.code).json({ error: gate.error });
  try {
    const { data, error } = await supabase.from('resource_files').insert({
      school_id: gate.userCtx.school_id,
      folder_id: req.body.folderId || null,
      title: String(title).trim(),
      file_url: fileUrl,
      file_type: req.body.fileType || null,
      file_size: req.body.fileSize || 0,
      scope: req.body.scope ? normalizeCurriculum(req.body.scope) : 'school',
      uploaded_by: gate.userCtx.email,
    }).select('id').single();
    if (error) throw error;
    res.status(201).json({ ok: true, id: data.id });
  } catch (err) {
    console.error('[POST /resources/file] error:', err.message);
    res.status(500).json({ error: 'Failed to add file' });
  }
});

// DELETE /resources/folder/:id  { email }  (school-scoped; cascade removes children)
router.delete('/folder/:id', async (req, res) => {
  const gate = await requireManager(req.body?.email);
  if (!gate.ok) return res.status(gate.code).json({ error: gate.error });
  try {
    const { error } = await supabase.from('resource_folders')
      .delete().eq('id', req.params.id).eq('school_id', gate.userCtx.school_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /resources/folder] error:', err.message);
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

// DELETE /resources/file/:id  { email }
router.delete('/file/:id', async (req, res) => {
  const gate = await requireManager(req.body?.email);
  if (!gate.ok) return res.status(gate.code).json({ error: gate.error });
  try {
    const { error } = await supabase.from('resource_files')
      .delete().eq('id', req.params.id).eq('school_id', gate.userCtx.school_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /resources/file] error:', err.message);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

module.exports = router;
