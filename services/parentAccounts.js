/**
 * Ported from ai-mentor/server/services/studentAccounts.js — parent-specific
 * login-id generation only (createFirebaseAccount/generateSecurePassword/
 * toTitleCase are generic and already live in services/teacherAccounts.js).
 */
const supabase = require('./supabase');

// Simple, typeable login IDs — p1, p2, p3, ... @aivorah.parent. Collision-safe:
// checks the DB for the next unused number.
async function generateParentLoginId() {
  for (let n = 1; n < 100000; n++) {
    const candidate = `p${n}@aivorah.parent`;
    const { data: existing } = await supabase.from('users').select('id').eq('email', candidate).maybeSingle();
    if (!existing) return candidate;
  }
  return `p${Date.now()}@aivorah.parent`;
}

module.exports = { generateParentLoginId };
