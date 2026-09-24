// Live check: school-admin must read the same Supabase project as the auth service.
// Run: SMOKE_ADMIN_EMAIL=... npm run test -- tests/smoke
const ADMIN = process.env.SMOKE_ADMIN_EMAIL || 'schooladmin.tsra.test@aivorah.com';
const SCHOOL_ADMIN = process.env.SCHOOL_ADMIN_URL || 'https://aivorah-school-admin-service.onrender.com';
const AUTH = process.env.AUTH_URL || 'https://aivorah-auth-service-g27s.onrender.com';

test('school-admin and auth service resolve the same school for the test admin', async () => {
  const sa = await (await fetch(`${SCHOOL_ADMIN}/school-admin/overview?adminEmail=${encodeURIComponent(ADMIN)}`)).json();
  const auth = await (await fetch(`${AUTH}/user/sync`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN }),
  })).json();
  expect(sa.school.id).toBe(auth.schoolId);
}, 90000);
