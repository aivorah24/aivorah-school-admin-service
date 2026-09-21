// Ported verbatim (business logic unchanged) from ai-mentor/server/routes/announcements.js.
const express = require('express');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const router = express.Router();
const supabase = require('../services/supabase');
const { requireAdminScope, canManageAnnouncement } = require('../services/adminScope');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    const mime = file.mimetype || '';
    const validExt  = /^(pdf|png|jpg|jpeg|gif|webp)$/.test(ext);
    const validMime = /^(image\/(jpeg|png|gif|webp)|application\/pdf)$/.test(mime);
    if (validExt && validMime) return cb(null, true);
    cb(new Error('Only images (JPG, PNG, GIF, WebP) and PDFs are allowed'));
  },
});

async function getUserContext(email) {
  if (!email) return null;
  const { data, error } = await supabase
    .from('users')
    .select('id, role, school_id, email')
    .eq('email', String(email).toLowerCase().trim())
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getTaughtByTeacherIds(userCtx) {
  if (!userCtx || userCtx.role !== 'parent' || !userCtx.email) return new Set();
  const { data: kids, error } = await supabase
    .from('parent_children')
    .select('child_id')
    .eq('parent_email', userCtx.email);
  if (error || !kids?.length) return new Set();
  const childIds = kids.map((k) => k.child_id);
  const { data: links, error: err2 } = await supabase
    .from('teacher_student')
    .select('teacher_id')
    .in('student_id', childIds);
  if (err2) return new Set();
  return new Set((links || []).map((t) => t.teacher_id));
}

function scopeTargets(scope, targets) {
  if (scope.scopeType === 'global') return Array.isArray(targets) ? targets : [];
  if (scope.scopeType === 'teacher') {
    return [{ schoolId: scope.schoolId, role: 'parent', teacherId: scope.teacherId }];
  }
  const roleRows = (Array.isArray(targets) ? targets : [])
    .map((t) => t.role)
    .filter((r) => ['student', 'parent', 'teacher'].includes(r));
  const roles = [...new Set(roleRows)];
  if (!roles.length) return [{ schoolId: scope.schoolId, role: null }];
  return roles.map((role) => ({ schoolId: scope.schoolId, role }));
}

async function loadManageable(scope, announcementId) {
  const { data: a, error } = await supabase
    .from('announcements').select('*').eq('id', announcementId).maybeSingle();
  if (error) throw error;
  if (!a) return null;
  const targetsMap = await fetchTargetsMap([a.id]);
  const targets = targetsMap.get(a.id) || [];
  const allowed = await canManageAnnouncement(scope, a, targets);
  return allowed ? { announcement: a, targets } : null;
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const VALID_STATUSES = ['draft', 'scheduled', 'published', 'archived'];

function withinWindow(a, now) {
  if (a.starts_at && new Date(a.starts_at) > now) return false;
  if (a.expires_at && new Date(a.expires_at) <= now) return false;
  return true;
}

function isLiveForReaders(a, now) {
  if (a.status === 'published') return withinWindow(a, now);
  if (a.status === 'scheduled') return !!a.starts_at && withinWindow(a, now);
  return false;
}

async function fetchTargetsMap(announcementIds) {
  if (!announcementIds.length) return new Map();
  const { data, error } = await supabase
    .from('announcement_targets')
    .select('announcement_id, school_id, role, teacher_id')
    .in('announcement_id', announcementIds);
  if (error) throw error;
  const map = new Map();
  for (const t of data || []) {
    if (!map.has(t.announcement_id)) map.set(t.announcement_id, []);
    map.get(t.announcement_id).push(t);
  }
  return map;
}

async function fetchAnnouncementsWithTargets(statuses) {
  const { data: announcements, error } = await supabase
    .from('announcements')
    .select('*')
    .in('status', statuses);
  if (error) throw error;
  const items = announcements || [];
  const targetsMap = await fetchTargetsMap(items.map((a) => a.id));
  return { items, targetsMap };
}

function matchesAudience(targets, userCtx, taughtByTeacherIds) {
  if (!targets || targets.length === 0) return true;
  if (!userCtx?.school_id) {
    return targets.every((t) => !t.school_id && !t.teacher_id)
        && targets.some((t) => !t.role || t.role === userCtx?.role);
  }
  return targets.some((t) => {
    const schoolOk = !t.school_id || t.school_id === userCtx.school_id;
    const roleOk = !t.role || t.role === userCtx.role;
    const teacherOk = !t.teacher_id || !!taughtByTeacherIds?.has(t.teacher_id);
    return schoolOk && roleOk && teacherOk;
  });
}

async function fetchUserState(userId, announcementIds) {
  if (!userId || !announcementIds.length) return new Map();
  const { data, error } = await supabase
    .from('announcement_user_state')
    .select('announcement_id, seen_at, dismissed_at, dismissed_version')
    .eq('user_id', userId)
    .in('announcement_id', announcementIds);
  if (error) throw error;
  return new Map((data || []).map((s) => [s.announcement_id, s]));
}

async function fetchAttachmentsMap(announcementIds) {
  if (!announcementIds.length) return new Map();
  try {
    const { data, error } = await supabase
      .from('announcement_attachments')
      .select('id, announcement_id, url, file_name, file_type, file_size')
      .in('announcement_id', announcementIds);
    if (error) throw error;
    const map = new Map();
    for (const att of data || []) {
      if (!map.has(att.announcement_id)) map.set(att.announcement_id, []);
      map.get(att.announcement_id).push({
        id: att.id, url: att.url, name: att.file_name, type: att.file_type, size: att.file_size,
      });
    }
    return map;
  } catch (err) {
    console.warn('[announcements] attachments lookup failed:', err.message);
    return new Map();
  }
}

async function fetchSchoolNames(schoolIds) {
  const distinct = [...new Set(schoolIds.filter(Boolean))];
  if (!distinct.length) return new Map();
  try {
    const { data, error } = await supabase.from('schools').select('id, name').in('id', distinct);
    if (error) throw error;
    return new Map((data || []).map((s) => [s.id, s.name]));
  } catch (err) {
    console.warn('[announcements] school name lookup failed:', err.message);
    return new Map();
  }
}

async function fetchSenderNames(emails) {
  const distinct = [...new Set(emails.filter(Boolean))];
  if (!distinct.length) return new Map();
  try {
    const { data, error } = await supabase.from('users').select('email, name').in('email', distinct);
    if (error) throw error;
    return new Map((data || []).map((u) => [u.email, u.name]));
  } catch (err) {
    console.warn('[announcements] sender name lookup failed:', err.message);
    return new Map();
  }
}

function serialize(a, { state, senderName, targets, attachments, schoolNames } = {}) {
  const targetRows = targets || [];
  const audienceRoles = [...new Set(targetRows.map((t) => t.role).filter(Boolean))];
  const schoolIds = [...new Set(targetRows.map((t) => t.school_id).filter(Boolean))];
  const audienceSchoolName = schoolIds.length === 1 ? (schoolNames?.get(schoolIds[0]) || null) : null;
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    severity: a.severity,
    displayType: a.display_type,
    status: a.status,
    isDismissible: a.is_dismissible,
    contentVersion: a.content_version,
    createdBy: a.created_by,
    createdByName: senderName || null,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    startsAt: a.starts_at,
    expiresAt: a.expires_at,
    audienceRoles,
    audienceSchoolId: schoolIds.length === 1 ? schoolIds[0] : null,
    audienceSchoolName,
    attachments: attachments || [],
    isSeen: !!state?.seen_at,
    isDismissed: !!state?.dismissed_at && (state.dismissed_version ?? 0) >= a.content_version,
  };
}

async function serializeList(announcements, targetsMap, userCtx) {
  const ids = announcements.map((a) => a.id);
  const [stateMap, nameMap, attachmentsMap] = await Promise.all([
    userCtx ? fetchUserState(userCtx.id, ids) : Promise.resolve(new Map()),
    fetchSenderNames(announcements.map((a) => a.created_by)),
    fetchAttachmentsMap(ids),
  ]);
  const allSchoolIds = [];
  for (const rows of targetsMap.values()) for (const t of rows) allSchoolIds.push(t.school_id);
  const schoolNames = await fetchSchoolNames(allSchoolIds);

  return announcements.map((a) => serialize(a, {
    state: stateMap.get(a.id),
    senderName: nameMap.get(a.created_by),
    targets: targetsMap.get(a.id),
    attachments: attachmentsMap.get(a.id),
    schoolNames,
  }));
}

// ── User-facing endpoints ───────────────────────────────────────────────────

router.get('/active', async (req, res) => {
  const userEmail = req.query.userEmail;
  const surface = req.query.surface === 'inbox' ? 'inbox' : 'banner';
  try {
    const userCtx = userEmail ? await getUserContext(userEmail) : null;
    const taughtByTeacherIds = await getTaughtByTeacherIds(userCtx);
    const now = new Date();

    const { items, targetsMap } = await fetchAnnouncementsWithTargets(['published', 'scheduled']);
    const matched = items
      .filter((a) => isLiveForReaders(a, now))
      .filter((a) => matchesAudience(targetsMap.get(a.id), userCtx, taughtByTeacherIds))
      .filter((a) => a.display_type === surface || a.display_type === 'both');

    const serialized = await serializeList(matched, targetsMap, userCtx);
    const result = serialized
      .filter((a) => !a.isDismissible || !a.isDismissed)
      .sort((x, y) => {
        const sevDiff = (SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9);
        if (sevDiff !== 0) return sevDiff;
        return new Date(y.createdAt) - new Date(x.createdAt);
      });

    res.json(result);
  } catch (err) {
    console.error('[GET /announcements/active] error:', err.message);
    res.status(500).json({ error: 'Failed to load announcements' });
  }
});

router.get('/', async (req, res) => {
  const userEmail = req.query.userEmail;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const statusFilter = req.query.status === 'unread' ? 'unread' : 'all';

  try {
    const userCtx = userEmail ? await getUserContext(userEmail) : null;
    const taughtByTeacherIds = await getTaughtByTeacherIds(userCtx);
    const now = new Date();

    const { items: all, targetsMap } = await fetchAnnouncementsWithTargets(['published', 'scheduled', 'archived']);
    const matched = all
      .filter((a) => a.status === 'archived' || isLiveForReaders(a, now))
      .filter((a) => matchesAudience(targetsMap.get(a.id), userCtx, taughtByTeacherIds))
      .filter((a) => a.display_type === 'inbox' || a.display_type === 'both')
      .sort((x, y) => new Date(y.created_at) - new Date(x.created_at));

    let itemsOut = await serializeList(matched, targetsMap, userCtx);
    if (statusFilter === 'unread') itemsOut = itemsOut.filter((a) => !a.isSeen);

    const total = itemsOut.length;
    const start = (page - 1) * limit;
    res.json({ items: itemsOut.slice(start, start + limit), total, page, limit });
  } catch (err) {
    console.error('[GET /announcements] error:', err.message);
    res.status(500).json({ error: 'Failed to load announcements' });
  }
});

async function upsertUserState(announcementId, userEmail, patch) {
  const userCtx = await getUserContext(userEmail);
  if (!userCtx) throw Object.assign(new Error('Unknown user'), { statusCode: 404 });
  const { error } = await supabase
    .from('announcement_user_state')
    .upsert({ announcement_id: announcementId, user_id: userCtx.id, ...patch }, { onConflict: 'announcement_id,user_id' });
  if (error) throw error;
}

// ── Admin endpoints (registered before /:id so /admin/* never falls through) ─

router.post('/admin/upload', requireAdminScope, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'aivorah/announcements',
      resource_type: 'auto',
      use_filename: true,
      unique_filename: true,
    });
    res.json({
      url: result.secure_url,
      name: req.file.originalname,
      size: req.file.size,
      type: path.extname(req.file.originalname).toLowerCase().replace('.', '') || 'file',
    });
  } catch (err) {
    console.error('[announcements/admin/upload]', err.message);
    res.status(500).json({ error: 'Could not upload the file. Please try again.' });
  }
});

async function replaceTargets(announcementId, targets) {
  const { error: delErr } = await supabase
    .from('announcement_targets').delete().eq('announcement_id', announcementId);
  if (delErr) throw delErr;
  if (Array.isArray(targets) && targets.length) {
    const rows = targets.map((t) => ({
      announcement_id: announcementId,
      school_id: t.schoolId || null,
      role: t.role || null,
      teacher_id: t.teacherId || null,
    }));
    const { error } = await supabase.from('announcement_targets').insert(rows);
    if (error) throw error;
  }
}

async function replaceAttachments(announcementId, attachments) {
  const { error: delErr } = await supabase
    .from('announcement_attachments').delete().eq('announcement_id', announcementId);
  if (delErr) throw delErr;
  if (Array.isArray(attachments) && attachments.length) {
    const rows = attachments.map((att) => ({
      announcement_id: announcementId,
      url: att.url,
      file_name: att.name || 'attachment',
      file_type: att.type || 'file',
      file_size: att.size || 0,
    }));
    const { error } = await supabase.from('announcement_attachments').insert(rows);
    if (error) throw error;
  }
}

async function serializeOne(announcementId) {
  const { data: a, error } = await supabase
    .from('announcements').select('*').eq('id', announcementId).single();
  if (error) throw error;
  const targetsMap = await fetchTargetsMap([a.id]);
  const [one] = await serializeList([a], targetsMap, null);
  return one;
}

router.post('/admin', requireAdminScope, async (req, res) => {
  const { title, body, severity, displayType, status, startsAt, expiresAt, isDismissible, targets, attachments } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
  const desiredStatus = VALID_STATUSES.includes(status) ? status : 'draft';
  if (desiredStatus === 'scheduled' && !startsAt) {
    return res.status(400).json({ error: 'A scheduled announcement needs a start date' });
  }

  try {
    const { data: a, error } = await supabase
      .from('announcements')
      .insert({
        title, body,
        severity: severity || 'info',
        display_type: displayType || 'inbox',
        status: desiredStatus,
        starts_at: startsAt || null,
        expires_at: expiresAt || null,
        is_dismissible: isDismissible !== false,
        created_by: req.adminEmail,
      })
      .select('*').single();
    if (error) throw error;

    await replaceTargets(a.id, scopeTargets(req.adminScope, targets));
    if (Array.isArray(attachments) && attachments.length) await replaceAttachments(a.id, attachments);

    res.status(201).json(await serializeOne(a.id));
  } catch (err) {
    console.error('[POST /announcements/admin] error:', err.message);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

router.post('/admin/ai-draft', requireAdminScope, async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'A short description of the announcement is required' });
  try {
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [{
        role: 'user',
        content: `Draft a school announcement from this request: "${prompt}"

Match this house style exactly (real examples from the school below) — write it so it reads like the school's own admin office wrote it, not generic AI copy:
- Open with "Dear [specific audience — e.g. Parents / PYP 5 Parents / EYP 1 - PYP 5 Parents]," then "Namaste!" on its own line. If the request doesn't say who it's for, use "Dear Parents,".
- Keep sentences short and plain. Bold the important nouns/phrases inline as you go — dates, deadlines, times, app/portal names, form names, key actions — the way a person skimming for the important bit would want them to jump out. Don't wrap the whole message or a whole sentence in bold, just the key terms.
- When there's more than one instruction, step, or point, use a numbered list (1. 2. 3.) for sequential steps or a bulleted list (- item) for a flat set of points — whichever the real examples below use for a similar case.
- Include every concrete detail actually given in the request (dates, links, times, names, amounts) verbatim — never invent a placeholder date, link, or name that wasn't given.
- Close with "Warm regards," then the sender/team name on its own line — infer a fitting one from context (e.g. "Sports Team, TSRA" for a sports notice, "PYP Team" for a PYP academic notice), defaulting to "Team TSRA" if nothing more specific fits.
- Only use this markdown: **bold**, - bullet, 1. numbered, [label](https://url) for a real link (only if a URL was given — never invent one). No headings (##) — the Title field already carries that role.

Real examples of the house style to match (structure and tone, not the specific content):

Example 1 —
Title: Reporting Time – PYP & MYP Own-Transport Students
Body:
Namaste, Parents!

This is to inform you that PYP and MYP students who use their own transport are required to report to school by **8:00 a.m.**

We have observed that a number of students regularly report after 8:00 a.m. Starting **tomorrow, 14 July 2026**, the following will apply to students reporting late.

1. Late-arriving students will assemble outside the Head of School's Office on arrival.
2. The Head of School will personally speak with the student regarding punctuality.
3. Repeated late-coming will be communicated directly to parents and may be followed by a meeting with the Head of School or the respective Coordinator to address the matter.

Punctuality supports your child's readiness for the school day and is an important part of building responsibility. We request your cooperation in ensuring students leave home in good time to reach school by 8:00 a.m.

Warm regards,
Team TSRA

Example 2 —
Title: EYP 1 – PYP 5 Class Timetable Available on Toddle Family App
Body:
Dear EYP 1 - PYP 5 Parents,

Namaste!

The **class timetable** for your child's section is now available on the **Toddle Family App**.

To access it:
1. Open the **Toddle Family App**.
2. Tap on the **Timetable** icon.
3. View your child's weekly schedule from **Monday to Friday**.

The timetable is section-specific, allowing you to view the schedule for your child's class.

If you have any questions, please feel free to reach out to your child's Homeroom Teacher (HRT) through **Toddle Family Messaging**.

Warm regards,
PYP Team

Respond ONLY as valid JSON: {"title": "specific, descriptive title matching the examples' style, under 80 characters", "body": "the announcement body"}`,
      }],
      response_format: { type: 'json_object' },
    });
    const result = JSON.parse(completion.choices[0].message.content);
    const title = String(result?.title || '').trim();
    const body = String(result?.body || '').trim();
    if (!title || !body) return res.status(502).json({ error: 'AI draft came back empty. Please try again.' });
    res.json({ title, body });
  } catch (err) {
    console.error('[POST /announcements/admin/ai-draft] error:', err.message);
    res.status(500).json({ error: 'Failed to draft with AI. Please try again.' });
  }
});

router.patch('/admin/:id', requireAdminScope, async (req, res) => {
  const { title, body, severity, displayType, status, startsAt, expiresAt, isDismissible, targets, attachments, bumpVersion } = req.body || {};
  try {
    const manageable = await loadManageable(req.adminScope, req.params.id);
    if (!manageable) return res.status(403).json({ error: 'Not authorized to manage this announcement' });

    const patch = { updated_at: new Date().toISOString() };
    if (title !== undefined) patch.title = title;
    if (body !== undefined) patch.body = body;
    if (severity !== undefined) patch.severity = severity;
    if (displayType !== undefined) patch.display_type = displayType;
    if (status !== undefined && VALID_STATUSES.includes(status)) patch.status = status;
    if (startsAt !== undefined) patch.starts_at = startsAt;
    if (expiresAt !== undefined) patch.expires_at = expiresAt;
    if (isDismissible !== undefined) patch.is_dismissible = isDismissible;

    if (bumpVersion) {
      const { data: current } = await supabase
        .from('announcements').select('content_version').eq('id', req.params.id).maybeSingle();
      patch.content_version = (current?.content_version || 1) + 1;
    }

    const { error } = await supabase
      .from('announcements').update(patch).eq('id', req.params.id).select('id').single();
    if (error) throw error;

    if (targets !== undefined) await replaceTargets(req.params.id, scopeTargets(req.adminScope, targets));
    if (attachments !== undefined) await replaceAttachments(req.params.id, attachments);

    res.json(await serializeOne(req.params.id));
  } catch (err) {
    console.error('[PATCH /announcements/admin/:id] error:', err.message);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

router.post('/admin/:id/publish', requireAdminScope, async (req, res) => {
  try {
    const manageable = await loadManageable(req.adminScope, req.params.id);
    if (!manageable) return res.status(403).json({ error: 'Not authorized to manage this announcement' });

    const { error } = await supabase
      .from('announcements')
      .update({ status: 'published', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select('id').single();
    if (error) throw error;
    res.json(await serializeOne(req.params.id));
  } catch (err) {
    console.error('[POST /announcements/admin/:id/publish] error:', err.message);
    res.status(500).json({ error: 'Failed to publish announcement' });
  }
});

router.post('/admin/:id/archive', requireAdminScope, async (req, res) => {
  try {
    const manageable = await loadManageable(req.adminScope, req.params.id);
    if (!manageable) return res.status(403).json({ error: 'Not authorized to manage this announcement' });

    const { error } = await supabase
      .from('announcements')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select('id').single();
    if (error) throw error;
    res.json(await serializeOne(req.params.id));
  } catch (err) {
    console.error('[POST /announcements/admin/:id/archive] error:', err.message);
    res.status(500).json({ error: 'Failed to archive announcement' });
  }
});

router.get('/admin/all', requireAdminScope, async (req, res) => {
  try {
    let query = supabase.from('announcements').select('*').order('created_at', { ascending: false });
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) throw error;
    let items = data || [];
    const targetsMap = await fetchTargetsMap(items.map((a) => a.id));

    if (req.adminScope.scopeType === 'school' || req.adminScope.scopeType === 'teacher') {
      const checks = await Promise.all(
        items.map((a) => canManageAnnouncement(req.adminScope, a, targetsMap.get(a.id) || []))
      );
      items = items.filter((_, i) => checks[i]);
    }

    res.json(await serializeList(items, targetsMap, null));
  } catch (err) {
    console.error('[GET /announcements/admin/all] error:', err.message);
    res.status(500).json({ error: 'Failed to load announcements' });
  }
});

router.get('/admin/schools', requireAdminScope, async (req, res) => {
  try {
    let query = supabase.from('schools').select('id, name').order('name');
    if (req.adminScope.scopeType === 'school' || req.adminScope.scopeType === 'teacher') query = query.eq('id', req.adminScope.schoolId);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('[GET /announcements/admin/schools] error:', err.message);
    res.status(500).json({ error: 'Failed to load schools' });
  }
});

// ── Parameterized user routes — registered LAST so /admin/* never matches /:id ─

router.get('/:id', async (req, res) => {
  try {
    const { data: a, error } = await supabase
      .from('announcements').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!a) return res.status(404).json({ error: 'Not found' });

    const userCtx = req.query.userEmail ? await getUserContext(req.query.userEmail) : null;
    const targetsMap = await fetchTargetsMap([a.id]);
    const [one] = await serializeList([a], targetsMap, userCtx);
    res.json(one);
  } catch (err) {
    console.error('[GET /announcements/:id] error:', err.message);
    res.status(500).json({ error: 'Failed to load announcement' });
  }
});

router.post('/:id/seen', async (req, res) => {
  try {
    await upsertUserState(req.params.id, req.body?.userEmail, { seen_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /announcements/:id/seen] error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to mark seen' });
  }
});

router.post('/:id/dismiss', async (req, res) => {
  try {
    const { data: a, error } = await supabase
      .from('announcements').select('content_version, is_dismissible').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!a.is_dismissible) return res.status(400).json({ error: 'This announcement cannot be dismissed' });

    await upsertUserState(req.params.id, req.body?.userEmail, {
      dismissed_at: new Date().toISOString(),
      dismissed_version: a.content_version,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /announcements/:id/dismiss] error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to dismiss' });
  }
});

module.exports = router;
