const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const { generateParentLoginId } = require('../../services/parentAccounts');

beforeEach(() => { mockSb.reset(); });

test('returns the lowest p<N> unused in users', async () => {
  mockSb.setTable('users', [{ data: { id: 'a' }, error: null }, { data: null, error: null }]);
  await expect(generateParentLoginId()).resolves.toBe('p2@aivorah.parent');
});

test('skips excluded candidates (taken in Firebase) without querying them', async () => {
  const exclude = new Set(['p1@aivorah.parent', 'p2@aivorah.parent']);
  await expect(generateParentLoginId({ attempt: 1, exclude })).resolves.toBe('p3@aivorah.parent');
});

test('switches to a random suffix after the sequential attempts', async () => {
  const id = await generateParentLoginId({ attempt: 3 });
  expect(id).toMatch(/^p\d{6}@aivorah\.parent$/);
});
