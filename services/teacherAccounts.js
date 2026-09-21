/**
 * Ported verbatim from ai-mentor/server/services/studentAccounts.js — only
 * the pieces POST /teachers needs (password/email generation, Firebase
 * signup, title-casing). Pure/stateless except createFirebaseAccount, which
 * hits Firebase's REST signup endpoint directly (no Admin SDK needed).
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

module.exports = { generateSecurePassword, generateStaffEmail, createFirebaseAccount, toTitleCase };
