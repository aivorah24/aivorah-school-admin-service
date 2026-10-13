/**
 * Class Portfolio — teacher-posted photos/videos with a caption, optional
 * student tags, likes and comments, scoped to one grade+section. See
 * server/sql/class_portfolio.sql for the schema and services/classAccess.js
 * for the homeroom-teacher / reader authorization rules.
 */
const express = require('express');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const router = express.Router();
const supabase = require('../services/supabase');
const { requireHomeroomTeacher, getUserContext, canViewClass } = require('../services/classAccess');
const { notifyClassPost, clearClassPostNotifications } = require('../services/classPostNotifications');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Images + video (unlike messages.js/announcements.js, which are image/PDF
// only) — resource_type: 'auto' on the Cloudinary call below already handles
// both with no extra branching.
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB — covers longer class-activity clips
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    const mime = file.mimetype || '';
    const validExt  = /^(png|jpg|jpeg|gif|webp|mp4|mov|webm|m4v)$/.test(ext);
    const validMime = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|quicktime|webm|x-m4v))$/.test(mime);
    if (validExt && validMime) return cb(null, true);
    cb(new Error('Only images (JPG, PNG, GIF, WebP) and video (MP4, MOV, WEBM) are allowed'));
  },
});

// POST /class-portfolio/upload — multipart 'file' → Cloudinary.
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const mime = req.file.mimetype || '';
    const fileType = mime.startsWith('video/') ? 'video' : 'image';
    const dataUri = `data:${mime};base64,${req.file.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'aivorah/class_portfolio',
      resource_type: 'auto',
    });
    res.json({
      url: result.secure_url,
      name: req.file.originalname,
      size: req.file.size,
      type: fileType,
    });
  } catch (err) {
    console.error('[class-portfolio/upload]', err.message);
    res.status(500).json({ error: 'Could not upload the file. Please try again.' });
  }
});

async function fetchNames(emails) {
  const distinct = [...new Set(emails.filter(Boolean))];
  if (!distinct.length) return new Map();
  const { data } = await supabase.from('users').select('email, name').in('email', distinct);
  return new Map((data || []).map((u) => [u.email, u.name]));
}

async function fetchStudentNames(ids) {
  const distinct = [...new Set(ids.filter(Boolean))];
  if (!distinct.length) return new Map();
  const { data } = await supabase.from('users').select('id, name').in('id', distinct);
  return new Map((data || []).map((u) => [u.id, u.name]));
}

async function serializePosts(posts, viewerUserId) {
  const ids = posts.map((p) => p.id);
  if (!ids.length) return [];

  const [{ data: attachments }, { data: tags }, { data: likes }, { data: comments }] = await Promise.all([
    supabase.from('class_portfolio_attachments').select('*').in('post_id', ids).order('position'),
    supabase.from('class_portfolio_tags').select('*').in('post_id', ids),
    supabase.from('class_portfolio_likes').select('post_id, user_id').in('post_id', ids),
    supabase.from('class_portfolio_comments').select('post_id').in('post_id', ids),
  ]);

  const folderIds = posts.map(p => p.folder_id).filter(Boolean);
  let folderMap = new Map();
  if (folderIds.length > 0) {
    const { data: folders } = await supabase.from('class_portfolio_folders').select('id, name, color').in('id', folderIds);
    folderMap = new Map((folders || []).map(f => [f.id, f]));
  }

  const nameMap = await fetchNames(posts.map((p) => p.created_by));
  const studentNameMap = await fetchStudentNames((tags || []).map((t) => t.student_id));

  const attByPost = groupBy(attachments || [], 'post_id');
  const tagsByPost = groupBy(tags || [], 'post_id');
  const likesByPost = groupBy(likes || [], 'post_id');
  const commentsByPost = groupBy(comments || [], 'post_id');

  return posts.map((p) => ({
    id: p.id,
    grade: p.grade,
    section: p.section,
    caption: p.caption,
    status: p.status,
    createdBy: p.created_by,
    createdByName: nameMap.get(p.created_by) || null,
    createdAt: p.created_at,
    attachments: (attByPost.get(p.id) || []).map((a) => ({
      url: a.url, type: a.file_type, name: a.file_name, size: a.file_size,
    })),
    tags: (tagsByPost.get(p.id) || []).map((t) => ({
      studentId: t.student_id, studentName: studentNameMap.get(t.student_id) || null,
    })),
    likeCount: (likesByPost.get(p.id) || []).length,
    isLiked: viewerUserId ? (likesByPost.get(p.id) || []).some((l) => l.user_id === viewerUserId) : false,
    commentCount: (commentsByPost.get(p.id) || []).length,
    folderId: p.folder_id || null,
    folderName: folderMap.get(p.folder_id)?.name || null,
    folderColor: folderMap.get(p.folder_id)?.color || null,
  }));
}

function groupBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r[key])) map.set(r[key], []);
    map.get(r[key]).push(r);
  }
  return map;
}

// GET /class-portfolio/posts?grade=&section=&userEmail=
router.get('/posts', async (req, res) => {
  const { grade, section, userEmail } = req.query;
  if (!grade) return res.status(400).json({ error: 'grade required' });
  try {
    const userCtx = await getUserContext(userEmail);
    if (!userCtx) return res.status(404).json({ error: 'User not found' });
    if (!userCtx.school_id) return res.json({ posts: [] });
    const allowed = await canViewClass(userCtx, userCtx.school_id, grade, section);
    if (!allowed) return res.status(403).json({ error: 'Not authorized to view this class' });

    let query = supabase
      .from('class_portfolio_posts')
      .select('*')
      .eq('school_id', userCtx.school_id)
      .eq('grade', grade)
      .eq('section', section || '')
      .order('created_at', { ascending: false });
    // Only the homeroom teacher/admin sees drafts; everyone else sees published only.
    if (userCtx.role !== 'teacher' && userCtx.role !== 'school_admin') query = query.eq('status', 'published');
    const { data: posts, error } = await query;
    if (error) throw error;

    res.json({ posts: await serializePosts(posts || [], userCtx.id) });
  } catch (err) {
    console.error('[GET /class-portfolio/posts] error:', err.message);
    res.status(500).json({ error: 'Failed to load posts' });
  }
});

// POST /class-portfolio/posts
// { teacherEmail, grade, section, caption, status?, attachments?: [{url,type,name,size}], studentIds?: [] }
// schoolId is NEVER taken from the client — always re-derived from the
// teacher's own users row, same trust model as adminScope.js/classAccess.js.
router.post('/posts', async (req, res) => {
  const { teacherEmail, grade, section, caption, status, attachments, studentIds, folderId } = req.body || {};
  try {
    const teacherCtx = await getUserContext(teacherEmail);
    if (!teacherCtx?.school_id) return res.status(403).json({ error: 'Teacher is not assigned to a school' });
    const schoolId = teacherCtx.school_id;

    const scopeCheck = await requireHomeroomTeacher(teacherEmail, schoolId, grade, section);
    if (!scopeCheck.ok) return res.status(scopeCheck.statusCode).json({ error: scopeCheck.error });

    const { data: post, error } = await supabase
      .from('class_portfolio_posts')
      .insert({
        school_id: schoolId,
        grade,
        section: section || '',
        caption: caption || '',
        status: status === 'published' ? 'published' : 'draft',
        created_by: String(teacherEmail).toLowerCase().trim(),
        folder_id: folderId || null,
      })
      .select('*').single();
    if (error) throw error;

    if (Array.isArray(attachments) && attachments.length) {
      const rows = attachments.map((a, i) => ({
        post_id: post.id, url: a.url, file_type: a.type, file_name: a.name || null, file_size: a.size || null, position: i,
      }));
      const { error: attErr } = await supabase.from('class_portfolio_attachments').insert(rows);
      if (attErr) throw attErr;
    }
    if (Array.isArray(studentIds) && studentIds.length) {
      const rows = studentIds.map((sid) => ({ post_id: post.id, student_id: sid }));
      const { error: tagErr } = await supabase.from('class_portfolio_tags').insert(rows);
      if (tagErr) throw tagErr;
    }

    // Awaited (never throws) so the bell row exists before the teacher's feed refreshes.
    if (post.status === 'published') await notifyClassPost(post);

    const [serialized] = await serializePosts([post], null);
    res.status(201).json(serialized);
  } catch (err) {
    console.error('[POST /class-portfolio/posts] error:', err.message);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// POST /class-portfolio/posts/:id/publish  { teacherEmail }
router.post('/posts/:id/publish', async (req, res) => {
  try {
    const { data: post } = await supabase.from('class_portfolio_posts').select('*').eq('id', req.params.id).maybeSingle();
    if (!post) return res.status(404).json({ error: 'Not found' });
    const scopeCheck = await requireHomeroomTeacher(req.body?.teacherEmail, post.school_id, post.grade, post.section);
    if (!scopeCheck.ok) return res.status(scopeCheck.statusCode).json({ error: scopeCheck.error });

    const { error } = await supabase.from('class_portfolio_posts')
      .update({ status: 'published', updated_at: new Date().toISOString() }).eq('id', post.id);
    if (error) throw error;

    await notifyClassPost({ ...post, status: 'published' });

    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /class-portfolio/posts/:id/publish] error:', err.message);
    res.status(500).json({ error: 'Failed to publish' });
  }
});

// DELETE /class-portfolio/posts/:id
router.delete('/posts/:id', async (req, res) => {
  const { teacherEmail } = req.body || {};
  try {
    const { data: post } = await supabase.from('class_portfolio_posts').select('*').eq('id', req.params.id).maybeSingle();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const scopeCheck = await requireHomeroomTeacher(teacherEmail, post.school_id, post.grade, post.section);
    if (!scopeCheck.ok) return res.status(scopeCheck.statusCode).json({ error: scopeCheck.error });

    const { error } = await supabase.from('class_portfolio_posts').delete().eq('id', post.id);
    if (error) throw error;
    await clearClassPostNotifications(post.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /class-portfolio/posts/:id] error:', err.message);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// POST /class-portfolio/posts/:id/like  { userEmail }  — toggles.
router.post('/posts/:id/like', async (req, res) => {
  try {
    const userCtx = await getUserContext(req.body?.userEmail);
    if (!userCtx) return res.status(404).json({ error: 'User not found' });

    const { data: existing } = await supabase
      .from('class_portfolio_likes').select('*').eq('post_id', req.params.id).eq('user_id', userCtx.id).maybeSingle();
    if (existing) {
      await supabase.from('class_portfolio_likes').delete().eq('post_id', req.params.id).eq('user_id', userCtx.id);
      return res.json({ liked: false });
    }
    await supabase.from('class_portfolio_likes').insert({ post_id: req.params.id, user_id: userCtx.id });
    res.json({ liked: true });
  } catch (err) {
    console.error('[POST /class-portfolio/posts/:id/like] error:', err.message);
    res.status(500).json({ error: 'Failed to update like' });
  }
});

// GET /class-portfolio/posts/:id/comments
router.get('/posts/:id/comments', async (req, res) => {
  try {
    const { data: comments, error } = await supabase
      .from('class_portfolio_comments').select('*').eq('post_id', req.params.id).order('created_at');
    if (error) throw error;
    const nameMap = await fetchStudentNames((comments || []).map((c) => c.user_id));
    res.json((comments || []).map((c) => ({
      id: c.id, body: c.body, createdAt: c.created_at, userId: c.user_id, userName: nameMap.get(c.user_id) || null,
    })));
  } catch (err) {
    console.error('[GET /class-portfolio/posts/:id/comments] error:', err.message);
    res.status(500).json({ error: 'Failed to load comments' });
  }
});

// POST /class-portfolio/posts/:id/comments  { userEmail, body }
// Parent-only in V1 (matches the reference product — only adults comment;
// students see the counts but get no input, same gating MessagesScreen.tsx
// already applies to students).
router.post('/posts/:id/comments', async (req, res) => {
  const { userEmail, body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Comment body required' });
  try {
    const userCtx = await getUserContext(userEmail);
    if (!userCtx) return res.status(404).json({ error: 'User not found' });
    if (userCtx.role !== 'parent' && userCtx.role !== 'teacher' && userCtx.role !== 'school_admin') {
      return res.status(403).json({ error: 'Only parents and teachers can comment' });
    }
    const { data: comment, error } = await supabase
      .from('class_portfolio_comments')
      .insert({ post_id: req.params.id, user_id: userCtx.id, body: body.trim() })
      .select('*').single();
    if (error) throw error;
    res.status(201).json({ id: comment.id, body: comment.body, createdAt: comment.created_at, userId: comment.user_id });
  } catch (err) {
    console.error('[POST /class-portfolio/posts/:id/comments] error:', err.message);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// GET /class-portfolio/folders?grade=&section=&userEmail=
router.get('/folders', async (req, res) => {
  const { grade, section, userEmail } = req.query;
  if (!grade) return res.status(400).json({ error: 'grade required' });
  try {
    const userCtx = await getUserContext(userEmail);
    if (!userCtx) return res.status(404).json({ error: 'User not found' });
    if (!userCtx.school_id) return res.json([]);
    const allowed = await canViewClass(userCtx, userCtx.school_id, grade, section);
    if (!allowed) return res.status(403).json({ error: 'Not authorized to view this class' });

    const { data: folders, error } = await supabase
      .from('class_portfolio_folders')
      .select('*')
      .eq('school_id', userCtx.school_id)
      .eq('grade', grade)
      .eq('section', section || '');
    if (error) throw error;
    res.json(folders || []);
  } catch (err) {
    console.error('[GET /class-portfolio/folders] error:', err.message);
    res.status(500).json({ error: 'Failed to load folders' });
  }
});

// POST /class-portfolio/folders
// { teacherEmail, grade, section, name, color? }
router.post('/folders', async (req, res) => {
  const { teacherEmail, grade, section, name, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Folder name required' });
  try {
    const teacherCtx = await getUserContext(teacherEmail);
    if (!teacherCtx?.school_id) return res.status(403).json({ error: 'Teacher not assigned to school' });

    const scopeCheck = await requireHomeroomTeacher(teacherEmail, teacherCtx.school_id, grade, section);
    if (!scopeCheck.ok) return res.status(scopeCheck.statusCode).json({ error: scopeCheck.error });

    const { data: folder, error } = await supabase
      .from('class_portfolio_folders')
      .insert({
        school_id: teacherCtx.school_id,
        grade,
        section: section || '',
        name: name.trim(),
        color: color || '#0d9488',
        created_by: String(teacherEmail).toLowerCase().trim(),
      })
      .select('*').single();
    if (error) throw error;
    res.status(201).json(folder);
  } catch (err) {
    console.error('[POST /class-portfolio/folders] error:', err.message);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// PUT /class-portfolio/folders/:id
// { teacherEmail, name }
router.put('/folders/:id', async (req, res) => {
  const { teacherEmail, name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Folder name required' });
  try {
    const { data: folder } = await supabase.from('class_portfolio_folders').select('*').eq('id', req.params.id).maybeSingle();
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    const scopeCheck = await requireHomeroomTeacher(teacherEmail, folder.school_id, folder.grade, folder.section);
    if (!scopeCheck.ok) return res.status(scopeCheck.statusCode).json({ error: scopeCheck.error });

    const { data: updated, error } = await supabase
      .from('class_portfolio_folders')
      .update({ name: name.trim() })
      .eq('id', folder.id)
      .select('*').single();
    if (error) throw error;
    res.json(updated);
  } catch (err) {
    console.error('[PUT /class-portfolio/folders/:id] error:', err.message);
    res.status(500).json({ error: 'Failed to update folder' });
  }
});

// DELETE /class-portfolio/folders/:id
// { teacherEmail }
router.delete('/folders/:id', async (req, res) => {
  const { teacherEmail } = req.body || {};
  try {
    const { data: folder } = await supabase.from('class_portfolio_folders').select('*').eq('id', req.params.id).maybeSingle();
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    const scopeCheck = await requireHomeroomTeacher(teacherEmail, folder.school_id, folder.grade, folder.section);
    if (!scopeCheck.ok) return res.status(scopeCheck.statusCode).json({ error: scopeCheck.error });

    const { error } = await supabase.from('class_portfolio_folders').delete().eq('id', folder.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /class-portfolio/folders/:id] error:', err.message);
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

module.exports = router;
