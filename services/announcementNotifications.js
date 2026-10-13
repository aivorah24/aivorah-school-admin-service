/**
 * Notification V2 for announcements: every user the announcement targets gets a
 * bell row once it is live (aivorah-db 0016). announcements.notified_version
 * records the content_version already fanned out, so a re-publish or content
 * bump notifies once more and nothing else repeats. Scheduled announcements are
 * picked up by sweepDueAnnouncements() when their start time arrives.
 */
const supabase = require('./supabase');

const RECIPIENT_ROLES = ['student', 'parent', 'teacher', 'school_admin'];
const PAGE_SIZE = 1000;
const INSERT_CHUNK = 500;
const SWEEP_MIN_GAP_MS = 60 * 1000;
const TITLE_PREFIX = { critical: 'Urgent', warning: 'Important' };

function logEvent(fields) {
  console.log(JSON.stringify({ svc: 'school-admin', ...fields }));
}

function withinWindow(a, now) {
  if (a.starts_at && new Date(a.starts_at) > now) return false;
  if (a.expires_at && new Date(a.expires_at) <= now) return false;
  return true;
}

function isLiveForReaders(a, now = new Date()) {
  if (a.status === 'published') return withinWindow(a, now);
  if (a.status === 'scheduled') return !!a.starts_at && withinWindow(a, now);
  return false;
}

// Markdown body → one plain line for the bell.
function snippet(markdown) {
  const text = String(markdown || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/^\s*(?:[-•]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

function notificationTitle(a) {
  const prefix = TITLE_PREFIX[a.severity] || (a.content_version > 1 ? 'Updated announcement' : 'New announcement');
  return `${prefix}: ${a.title}`;
}

async function pagedUsers(applyFilters) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await applyFilters(supabase.from('users').select('id, email, role'))
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return out;
  }
}

// Parents of the students this teacher teaches (teacher-scoped announcements).
async function parentsTaughtBy(teacherId, schoolId) {
  const { data: links, error } = await supabase.from('teacher_student').select('student_id').eq('teacher_id', teacherId);
  if (error) throw error;
  const studentIds = [...new Set((links || []).map((l) => l.student_id))];
  if (!studentIds.length) return [];
  const { data: kids, error: kidsErr } = await supabase.from('parent_children').select('parent_email').in('child_id', studentIds);
  if (kidsErr) throw kidsErr;
  const emails = [...new Set((kids || []).map((k) => String(k.parent_email).toLowerCase()))];
  if (!emails.length) return [];
  return pagedUsers((q) => {
    let query = q.in('email', emails).eq('role', 'parent');
    if (schoolId) query = query.eq('school_id', schoolId);
    return query;
  });
}

// Same audience rules as matchesAudience() in routes/announcements.js.
async function resolveRecipients(targets) {
  const rows = targets?.length ? targets : [{ school_id: null, role: null, teacher_id: null }];
  const byId = new Map();
  for (const t of rows) {
    const users = t.teacher_id
      ? await parentsTaughtBy(t.teacher_id, t.school_id)
      : await pagedUsers((q) => {
        let query = t.role ? q.eq('role', t.role) : q.in('role', RECIPIENT_ROLES);
        if (t.school_id) query = query.eq('school_id', t.school_id);
        return query;
      });
    for (const u of users) if (RECIPIENT_ROLES.includes(u.role)) byId.set(u.id, u);
  }
  return [...byId.values()];
}

async function optedOutEmails(emails) {
  const distinct = [...new Set(emails.filter(Boolean).map((e) => String(e).toLowerCase()))];
  const out = new Set();
  for (let i = 0; i < distinct.length; i += PAGE_SIZE) {
    const { data } = await supabase.from('user_preferences').select('user_email, data').in('user_email', distinct.slice(i, i + PAGE_SIZE));
    for (const r of data || []) if (r.data?.announcements === false) out.add(String(r.user_email).toLowerCase());
  }
  return out;
}

// Never throws: the announcement is already saved; a notification failure is logged only.
async function notifyAnnouncement(announcementId) {
  try {
    const { data: a, error } = await supabase.from('announcements').select('*').eq('id', announcementId).maybeSingle();
    if (error) throw error;
    if (!a || !isLiveForReaders(a)) return { ok: true, skipped: 'not_live' };
    if ((a.notified_version || 0) >= a.content_version) return { ok: true, skipped: 'already_notified' };

    const { data: targets, error: tErr } = await supabase
      .from('announcement_targets').select('school_id, role, teacher_id').eq('announcement_id', a.id);
    if (tErr) throw tErr;

    const actor = String(a.created_by || '').toLowerCase();
    const users = (await resolveRecipients(targets || [])).filter((u) => String(u.email || '').toLowerCase() !== actor);
    const excluded = await optedOutEmails(users.map((u) => u.email));
    const recipients = users.filter((u) => !excluded.has(String(u.email || '').toLowerCase()));

    const title = notificationTitle(a);
    const body = snippet(a.body);
    const rows = recipients.map((u) => ({
      recipient_id: u.id,
      recipient_role: u.role,
      type: 'announcement',
      entity_type: 'announcement',
      entity_id: a.id,
      title,
      body,
      data: { announcementId: a.id, severity: a.severity, displayType: a.display_type },
      event_key: `announcement:announcement:${a.id}:v${a.content_version}`,
      actor_email: a.created_by,
      actor_role: 'admin',
    }));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const { error: insErr } = await supabase.from('notifications')
        .upsert(rows.slice(i, i + INSERT_CHUNK), { onConflict: 'recipient_id,event_key', ignoreDuplicates: true });
      if (insErr) throw insErr;
    }

    const { error: markErr } = await supabase.from('announcements').update({ notified_version: a.content_version }).eq('id', a.id);
    if (markErr) throw markErr;
    logEvent({ evt: 'announcement.notify', ok: true, announcement: a.id, version: a.content_version, recipients: rows.length, excluded: excluded.size });
    return { ok: true, inserted: rows.length };
  } catch (err) {
    logEvent({ evt: 'announcement.notify', ok: false, announcement: announcementId, reason: err.message });
    return { ok: false, error: err.message };
  }
}

// Archived/unpublished announcements must not leave bell rows behind.
async function clearAnnouncementNotifications(announcementId) {
  try {
    const { error } = await supabase.from('notifications').delete().eq('entity_type', 'announcement').eq('entity_id', announcementId);
    if (error) throw error;
    const { error: resetErr } = await supabase.from('announcements').update({ notified_version: null }).eq('id', announcementId);
    if (resetErr) throw resetErr;
    return { ok: true };
  } catch (err) {
    logEvent({ evt: 'announcement.clear', ok: false, announcement: announcementId, reason: err.message });
    return { ok: false, error: err.message };
  }
}

// Fans out announcements that went live on their own (scheduled start time reached).
let lastSweepAt = 0;
async function sweepDueAnnouncements({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastSweepAt < SWEEP_MIN_GAP_MS) return { ok: true, skipped: 'throttled' };
  lastSweepAt = now;
  try {
    const { data, error } = await supabase.from('announcements')
      .select('id, status, starts_at, expires_at, content_version, notified_version')
      .in('status', ['published', 'scheduled']);
    if (error) throw error;
    const due = (data || []).filter((a) => isLiveForReaders(a, new Date(now)) && (a.notified_version || 0) < a.content_version);
    for (const a of due) await notifyAnnouncement(a.id);
    return { ok: true, notified: due.length };
  } catch (err) {
    logEvent({ evt: 'announcement.sweep', ok: false, reason: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = {
  notifyAnnouncement, clearAnnouncementNotifications, sweepDueAnnouncements,
  isLiveForReaders, snippet, notificationTitle,
};
