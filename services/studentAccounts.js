/**
 * Shared student-account provisioning helpers — ported from
 * ai-mentor/server/services/studentAccounts.js. Pure, stateless logic (no
 * behavior change from the monolith copy).
 */
const { randomInt } = require('crypto');

function generateSecurePassword() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '#@$%&*?'];
  const all = groups.join('');
  const chars = groups.map(g => g[randomInt(g.length)]);
  while (chars.length < 10) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

// `attempt` > 0 adds a random nonce — a retry within the same millisecond
// (bulk import of two same-name students) would otherwise repeat the email.
function generateStudentEmail(name, school, attempt = 0) {
  const slug = String(name || 'student').trim().toLowerCase()
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '.').slice(0, 30);
  const schoolSlug = String(school || 'school').trim().toLowerCase()
    .replace(/[^a-z0-9]/g, '').slice(0, 10);
  const nonce = attempt > 0 ? randomInt(1000, 10000) : '';
  return `${slug}.${Date.now()}${nonce}@${schoolSlug}.student`;
}

// Same slug scheme as generateStudentEmail but for staff (teacher/parent)
// accounts created by a school_admin without a personal email on file — a
// distinct suffix (.staff) keeps them visually distinguishable from real
// personal emails and from system-generated student logins.
function generateStaffEmail(name, school, roleSuffix) {
  const slug = String(name || 'user').trim().toLowerCase()
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '.').slice(0, 30);
  const schoolSlug = String(school || 'school').trim().toLowerCase()
    .replace(/[^a-z0-9]/g, '').slice(0, 10);
  return `${slug}.${Date.now()}@${schoolSlug}.${roleSuffix || 'staff'}`;
}

async function createFirebaseAccount(email, password) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_API_KEY not set');
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: false }) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Firebase signup failed');
  return data.localId;
}

function toTitleCase(str) {
  return String(str || '').replace(/\b\w/g, c => c.toUpperCase());
}

// Sequential per-school admission-number generation (TSRA-1001 style).
// Best-effort — computed from the current count of students at that school.
function generateAdmissionNumber(schoolName, existingCount) {
  const prefix = String(schoolName || 'SCH').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'SCH';
  return `${prefix}-${1001 + existingCount}`;
}

module.exports = {
  generateSecurePassword,
  generateStudentEmail,
  generateStaffEmail,
  createFirebaseAccount,
  toTitleCase,
  generateAdmissionNumber,
};
