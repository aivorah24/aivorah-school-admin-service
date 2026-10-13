/**
 * Firebase Auth via the Identity Toolkit REST API (no Admin SDK credential is
 * configured in this service). signUp returns the idToken too, so a
 * just-created account can be deleted again if the users insert fails.
 */
const BASE = 'https://identitytoolkit.googleapis.com/v1/accounts';

async function signUp(email, password) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_API_KEY not set');
  const res = await fetch(`${BASE}:signUp?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) {
    // Firebase messages look like "EMAIL_EXISTS" or "WEAK_PASSWORD : ..." — keep the code.
    const code = String(data?.error?.message || 'SIGNUP_FAILED').split(':')[0].trim();
    const err = new Error(code);
    err.code = code;
    throw err;
  }
  return { uid: data.localId, idToken: data.idToken };
}

// Best-effort — a failed cleanup is logged, never thrown over the original error.
async function deleteAccount(idToken) {
  try {
    const apiKey = process.env.FIREBASE_API_KEY;
    const res = await fetch(`${BASE}:delete?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) console.warn('[firebaseAuth] delete failed:', res.status);
  } catch (err) {
    console.warn('[firebaseAuth] delete failed:', err.message);
  }
}

module.exports = { signUp, deleteAccount };
