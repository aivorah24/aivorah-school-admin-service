/**
 * Creates a Firebase login + users row as one unit.
 *
 * - Typed email: rejected with a 409 (code EMAIL_EXISTS) if the users table
 *   or Firebase already has it.
 * - Generated login (admin left email blank): a candidate taken in either the
 *   users table or Firebase is skipped and a new one generated — Firebase can
 *   hold accounts the users table no longer has (deleted users, earlier
 *   half-created accounts), so the DB check alone is not enough.
 * - If insertUser throws after Firebase signup, the Firebase account is deleted.
 */
const supabase = require('./supabase');
const firebaseAuth = require('./firebaseAuth');

const MAX_GENERATE_ATTEMPTS = 8;

function emailExistsError(message, existing) {
  const err = new Error(message);
  err.code = 'EMAIL_EXISTS';
  err.status = 409;
  if (existing) err.existing = existing;
  return err;
}

async function findUserByEmail(email) {
  const { data } = await supabase.from('users').select('id, name, email, role, school_id').eq('email', email).maybeSingle();
  return data || null;
}

async function signUpOrNull(email, password) {
  try {
    return await firebaseAuth.signUp(email, password);
  } catch (err) {
    if (err.code === 'EMAIL_EXISTS') return null;
    throw err;
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.email]            typed email ('' / undefined → generate)
 * @param {(ctx:{attempt:number, exclude:Set<string>}) => Promise<string>|string} opts.generate
 * @param {string} opts.password
 * @param {(email:string, firebaseUid:string) => Promise<void>} opts.insertUser
 * @param {string} opts.conflictMessage    409 message for a typed email that is taken
 * @returns {Promise<{email:string, firebaseUid:string, deleteFirebaseAccount:() => Promise<void>}>}
 */
async function provisionAccount({ email, generate, password, insertUser, conflictMessage }) {
  let account = null;
  let finalEmail = String(email || '').trim().toLowerCase();

  if (finalEmail) {
    const existing = await findUserByEmail(finalEmail);
    if (existing) throw emailExistsError(conflictMessage, existing);
    account = await signUpOrNull(finalEmail, password);
    if (!account) throw emailExistsError(conflictMessage);
  } else {
    const exclude = new Set();
    for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS && !account; attempt++) {
      const candidate = String(await generate({ attempt, exclude })).toLowerCase();
      exclude.add(candidate);
      if (await findUserByEmail(candidate)) continue;
      account = await signUpOrNull(candidate, password);
      if (account) finalEmail = candidate;
      else console.warn(`[provisionAccount] ${candidate} exists in Firebase only — regenerating`);
    }
    if (!account) throw new Error('Could not generate a unique login ID. Please try again.');
  }

  try {
    await insertUser(finalEmail, account.uid);
  } catch (err) {
    await firebaseAuth.deleteAccount(account.idToken);
    throw err;
  }

  return {
    email: finalEmail,
    firebaseUid: account.uid,
    // For callers that must undo the whole account after a later step fails.
    deleteFirebaseAccount: () => firebaseAuth.deleteAccount(account.idToken),
  };
}

module.exports = { provisionAccount, emailExistsError, MAX_GENERATE_ATTEMPTS };
