/**
 * Moving a student whose old school archived them to a new school.
 *
 * Archiving only sets users.status = 'archived'; the student keeps the old
 * school_id (so the old school can still list and restore them). That used to
 * strand them: the new school's Add Student said "This email is already
 * registered", and the student's own Connect to School request was refused
 * because their old approved request still counted as "linked". Now:
 *  - Add Student with an archived student's email moves the account
 *    (keeps the login and progress, no new password),
 *  - approving the student's request does the same,
 *  - archiving closes the student's approved request for that school.
 */
const supabase = require('./supabase');

// What Add Student should do with an email that already has an account.
//   transfer          archived by another school -> move them here
//   archived_here     archived by this school    -> restore instead
//   active_elsewhere  still active at another school
//   taken             anything else (teacher, parent, independent student...)
function transferVerdict(existing, schoolId) {
  if (!existing || existing.role !== 'student') return 'taken';
  if (!existing.school_id) return 'taken';
  if (existing.school_id === schoolId) return existing.status === 'archived' ? 'archived_here' : 'taken';
  return existing.status === 'archived' ? 'transfer' : 'active_elsewhere';
}

// The old school's class-teacher links; the new school assigns its own.
async function clearOldSchoolLinks(studentId) {
  for (const table of ['teacher_student', 'teacher_students']) {
    const { error } = await supabase.from(table).delete().eq('student_id', studentId);
    if (error) console.warn(`[studentTransfer] ${table}: ${error.message}`);
  }
}

// fields: users columns to set too (grade, section, curriculum, admission_number, ...).
async function moveStudentToSchool({ studentId, email, schoolId, schoolName, fields = {} }) {
  const { error } = await supabase.from('users')
    .update({ ...fields, school_id: schoolId, school: schoolName, status: 'active' })
    .eq('id', studentId);
  if (error) throw error;
  await clearOldSchoolLinks(studentId);

  const { data: pref } = await supabase.from('user_preferences').select('data').eq('user_email', email).maybeSingle();
  const data = { ...(pref?.data || {}), school: schoolName, schoolId, accountStatus: 'active' };
  if (fields.grade !== undefined) data.grade = fields.grade;
  if (fields.section !== undefined) data.section = fields.section;
  await supabase.from('user_preferences').upsert({ user_email: email, data });
}

// Archiving ends the link: an approved join request for this school must no
// longer block the student from asking another school. (school_access_requests
// is unique on user_email + school_id + status, so an older 'archived' row for
// the same school is replaced.)
async function closeApprovedRequests(emails, schoolId) {
  const list = (emails || []).filter(Boolean);
  if (!list.length) return;
  await supabase.from('school_access_requests').delete()
    .in('user_email', list).eq('school_id', schoolId).eq('status', 'archived');
  const { error } = await supabase.from('school_access_requests').update({ status: 'archived' })
    .in('user_email', list).eq('school_id', schoolId).eq('status', 'approved');
  if (error) console.warn(`[studentTransfer] close requests: ${error.message}`);
}

module.exports = { transferVerdict, moveStudentToSchool, clearOldSchoolLinks, closeApprovedRequests };
