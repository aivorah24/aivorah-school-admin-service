const crypto = require('crypto');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const PROJECT = 'ai-learning-platform-c1308';

function sign(payload, { kid = 'k1', key = privateKey } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid });
  const body = enc(payload);
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = (over = {}) => ({ aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, sub: 'uid1', email: 'a@x.com', exp: now() + 600, ...over });

beforeAll(() => {
  global.fetch = jest.fn(async () => ({ ok: true, headers: { get: () => 'max-age=3600' }, json: async () => ({ k1: PUB }) }));
});

const { verifyIdToken } = require('../../services/firebaseToken');

test('accepts a correctly signed token for this project', async () => {
  await expect(verifyIdToken(sign(good()))).resolves.toMatchObject({ email: 'a@x.com' });
});

test('rejects a tampered payload', async () => {
  const [h, , s] = sign(good()).split('.');
  const forged = Buffer.from(JSON.stringify(good({ email: 'admin@aivorah.ai' }))).toString('base64url');
  await expect(verifyIdToken(`${h}.${forged}.${s}`)).rejects.toThrow('bad signature');
});

test('rejects a token signed by another key', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await expect(verifyIdToken(sign(good(), { key: other }))).rejects.toThrow('bad signature');
});

test('rejects another Firebase project', async () => {
  await expect(verifyIdToken(sign(good({ aud: 'other-project' })))).rejects.toThrow('wrong project');
});

test('rejects an expired token', async () => {
  await expect(verifyIdToken(sign(good({ exp: now() - 3600 })))).rejects.toThrow('expired');
});

test('rejects unknown key id and junk', async () => {
  await expect(verifyIdToken(sign(good(), { kid: 'nope' }))).rejects.toThrow('unknown key');
  await expect(verifyIdToken('junk')).rejects.toThrow();
});
