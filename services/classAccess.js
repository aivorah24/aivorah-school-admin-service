/**
 * Homeroom-teacher / reader authorization for content scoped by
 * grade+section (e.g. the class timetable), ported from
 * ai-mentor/server/services/classAccess.js. Parallel to services/adminScope.js
 * but for the classTeacherEmail assignment stored on
 * schools.academic_structure (see services/academicStructure.js), not the
 * school_admin/global admin role hierarchy.
 */
const supabase = require('./supabase');
const { buildGradesSectionsView } = require('./academicStructure');

// Returns { ok: true } or { ok: false, statusCode, error }.
async function requireHomeroomTeacher(email, schoolId, grade, section) {
  const normalizedEmail = String(email || '').toLowerCase().trim();
  if (!normalizedEmail) return { ok: false, statusCode: 401, error: 'email required' };
  if (!schoolId || !grade) return { ok: false, statusCode: 400, error: 'schoolId and grade required' };

  const grades = await buildGradesSectionsView(schoolId);
  const gradeEntry = grades.find((g) => String(g.name).trim() === String(grade).trim());
  const sectionEntry = gradeEntry?.sections.find((s) => String(s.name).trim() === String(section || '').trim());
  const classTeacherEmail = String(sectionEntry?.classTeacherEmail || '').toLowerCase().trim();

  if (!classTeacherEmail || classTeacherEmail !== normalizedEmail) {
    return { ok: false, statusCode: 403, error: 'Only this class\'s homeroom teacher can do that' };
  }
  return { ok: true };
}

// Resolves { id, role, school_id, email, grade, section, curriculum } for a
// client-supplied email — identity is always re-looked-up server-side.
async function getUserContext(email) {
  if (!email) return null;
  const { data, error } = await supabase
    .from('users')
    .select('id, role, school_id, email, grade, section, curriculum')
    .eq('email', String(email).toLowerCase().trim())
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Can this reader (student/parent) see content for grade+section at this
// school? Students match their own grade+section; parents match any linked
// child's grade+section (via parent_children, keyed by parent_email).
async function canViewClass(userCtx, schoolId, grade, section) {
  if (!userCtx || userCtx.school_id !== schoolId) return false;
  if (userCtx.role === 'student') {
    return String(userCtx.grade || '').trim() === String(grade).trim()
      && String(userCtx.section || '').trim() === String(section || '').trim();
  }
  if (userCtx.role === 'parent') {
    const { data: kids } = await supabase
      .from('parent_children')
      .select('users!parent_children_child_id_fkey(grade, section)')
      .eq('parent_email', userCtx.email);
    return (kids || []).some((k) =>
      String(k.users?.grade || '').trim() === String(grade).trim()
      && String(k.users?.section || '').trim() === String(section || '').trim()
    );
  }
  if (userCtx.role === 'teacher' || userCtx.role === 'school_admin') return true; // homeroom teacher or admin, school already matched
  return false;
}

module.exports = { requireHomeroomTeacher, getUserContext, canViewClass };
