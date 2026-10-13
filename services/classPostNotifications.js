/**
 * Notification V2 for B2B class posts: every student in the post's class
 * (school + grade + section) and each of their linked parents gets a bell row
 * via notify_event (aivorah-db 0011). Recipients who turned off Teacher
 * Messages (or classPosts) in user_preferences are skipped.
 */
const supabase = require('./supabase');

const OPT_OUT_KEYS = ['teacherMessages', 'classPosts'];

function logEvent(fields) {
  console.log(JSON.stringify({ svc: 'school-admin', ...fields }));
}

function classLabel(grade, section) {
  return section ? `${grade}-${section}` : String(grade || 'your class');
}

function snippet(caption) {
  const text = String(caption || '').replace(/\s+/g, ' ').trim();
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

async function optedOutEmails(emails) {
  const distinct = [...new Set(emails.filter(Boolean).map((e) => String(e).toLowerCase()))];
  if (!distinct.length) return [];
  const { data } = await supabase.from('user_preferences').select('user_email, data').in('user_email', distinct);
  return (data || [])
    .filter((r) => OPT_OUT_KEYS.some((k) => r.data?.[k] === false))
    .map((r) => String(r.user_email).toLowerCase());
}

// Never throws: the post is already saved; a notification failure is logged only.
async function notifyClassPost(post) {
  try {
    if (!post?.id || post.status !== 'published') return { ok: false, skipped: 'not_published' };
    const { data: rows, error } = await supabase
      .from('users')
      .select('id, email, section')
      .eq('school_id', post.school_id)
      .eq('grade', post.grade)
      .eq('role', 'student');
    if (error) throw error;
    // Section filtered here so a null section matches a post with no section.
    const students = (rows || []).filter((s) => (s.section || '') === (post.section || ''));
    if (!students?.length) return { ok: true, skipped: 'no_students' };

    const studentIds = students.map((s) => s.id);
    const { data: links } = await supabase.from('parent_children').select('parent_email').in('child_id', studentIds);
    const excluded = await optedOutEmails([...students.map((s) => s.email), ...(links || []).map((l) => l.parent_email)]);

    const label = classLabel(post.grade, post.section);
    const body = snippet(post.caption) || 'New photos and updates from class';
    const { data, error: rpcErr } = await supabase.rpc('notify_event', {
      p_event: {
        type: 'class_post',
        entity_type: 'class_post',
        entity_id: post.id,
        version: post.created_at,
        student_ids: studentIds,
        exclude_emails: excluded,
        actor_email: post.created_by,
        actor_role: 'teacher',
        title: `New class post: ${label}`,
        body,
        parent_title: `New class post for {child}: ${label}`,
        data: { postId: post.id, grade: post.grade, section: post.section || '' },
      },
    });
    if (rpcErr) throw rpcErr;
    const inserted = data?.inserted?.length ?? 0;
    logEvent({ evt: 'class_post.notify', ok: true, post: post.id, students: studentIds.length, excluded: excluded.length, inserted });
    return { ok: true, inserted };
  } catch (err) {
    logEvent({ evt: 'class_post.notify', ok: false, post: post?.id, reason: err.message });
    return { ok: false, error: err.message };
  }
}

// A deleted post must not leave bell rows pointing at nothing.
async function clearClassPostNotifications(postId) {
  try {
    const { error } = await supabase.from('notifications').delete().eq('entity_type', 'class_post').eq('entity_id', postId);
    if (error) throw error;
    return { ok: true };
  } catch (err) {
    logEvent({ evt: 'class_post.clear', ok: false, post: postId, reason: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { notifyClassPost, clearClassPostNotifications, classLabel, snippet };
