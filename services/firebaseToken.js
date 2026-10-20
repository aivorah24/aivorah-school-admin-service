// Verifies Firebase ID tokens against Google's public certs (no service account needed).
const crypto = require('crypto');

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'ai-learning-platform-c1308';
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certCache = { certs: null, expires: 0 };

async function getCerts() {
  if (certCache.certs && Date.now() < certCache.expires) return certCache.certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`cert fetch ${res.status}`);
  const maxAge = Number((/max-age=(\d+)/.exec(res.headers.get('cache-control') || '') || [])[1] || 3600);
  certCache = { certs: await res.json(), expires: Date.now() + maxAge * 1000 };
  return certCache.certs;
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

async function verifyIdToken(token) {
  const [h, p, sig] = String(token).split('.');
  if (!h || !p || !sig) throw new Error('malformed token');
  const header = b64json(h);
  const payload = b64json(p);
  if (header.alg !== 'RS256') throw new Error('bad alg');
  const cert = (await getCerts())[header.kid];
  if (!cert) throw new Error('unknown key');
  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(cert, Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('bad signature');
  const now = Date.now() / 1000;
  if (payload.aud !== PROJECT_ID || payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) throw new Error('wrong project');
  if (!payload.exp || payload.exp < now - 60 || !payload.sub) throw new Error('expired');
  return payload;
}

module.exports = { verifyIdToken };
