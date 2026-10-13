/**
 * Ported from ai-mentor/server/services/studentAccounts.js — parent-specific
 * login-id generation only (createFirebaseAccount/generateSecurePassword/
 * toTitleCase are generic and already live in services/teacherAccounts.js).
 */
const { randomInt } = require('crypto');
const supabase = require('./supabase');

const SEQUENTIAL_ATTEMPTS = 3;

// Simple, typeable login IDs — p1, p2, p3, ... @aivorah.parent. Picks the next
// number unused in the users table, skipping `exclude` (candidates already
// found taken in Firebase by provisionAccount). After a few sequential misses
// it switches to a random suffix so a run of orphaned Firebase-only accounts
// can't block creation.
async function generateParentLoginId({ attempt = 0, exclude = new Set() } = {}) {
  if (attempt >= SEQUENTIAL_ATTEMPTS) return `p${randomInt(100000, 1000000)}@aivorah.parent`;
  for (let n = 1; n < 100000; n++) {
    const candidate = `p${n}@aivorah.parent`;
    if (exclude.has(candidate)) continue;
    const { data: existing } = await supabase.from('users').select('id').eq('email', candidate).maybeSingle();
    if (!existing) return candidate;
  }
  return `p${Date.now()}@aivorah.parent`;
}

module.exports = { generateParentLoginId };
