/**
 * Shared by routes/teachers.js and routes/parents.js — "Invited" is never
 * stored, it's derived from mustChangePassword in user_preferences, the same
 * signal the real login flow uses.
 */
const supabase = require('./supabase');

async function deriveStatusMap(emails) {
  const map = new Map();
  if (!emails.length) return map;
  const { data, error } = await supabase
    .from('user_preferences').select('user_email, data').in('user_email', emails);
  if (error) throw error;
  for (const row of data || []) map.set(row.user_email, row.data?.mustChangePassword !== false);
  return map;
}

function displayStatus(dbStatus, mustChangePassword) {
  if (dbStatus === 'inactive') return 'inactive';
  if (dbStatus === 'archived') return 'archived';
  return mustChangePassword ? 'invited' : 'active';
}

module.exports = { deriveStatusMap, displayStatus };
