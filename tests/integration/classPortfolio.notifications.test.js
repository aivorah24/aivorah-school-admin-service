const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);
jest.mock('../../services/classAccess', () => ({
  requireHomeroomTeacher: jest.fn(() => Promise.resolve({ ok: true })),
  getUserContext: jest.fn(() => Promise.resolve({ id: 't1', role: 'teacher', school_id: 'school-1', email: 'teacher@school.test' })),
  canViewClass: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../../services/classPostNotifications', () => ({
  notifyClassPost: jest.fn(() => Promise.resolve({ ok: true })),
  clearClassPostNotifications: jest.fn(() => Promise.resolve({ ok: true })),
}));

const request = require('supertest');
const app = require('../../index');
const { notifyClassPost, clearClassPostNotifications } = require('../../services/classPostNotifications');

const ROW = { id: 'post-1', school_id: 'school-1', grade: 'Grade 5', section: 'A', caption: 'Hi', created_by: 'teacher@school.test', created_at: '2026-10-13T09:00:00Z' };

beforeEach(() => { mockSb.reset(); jest.clearAllMocks(); });

test('publishing a new post notifies the class', async () => {
  mockSb.setTable('class_portfolio_posts', { data: { ...ROW, status: 'published' }, error: null });
  const res = await request(app).post('/class-portfolio/posts')
    .send({ teacherEmail: 'teacher@school.test', grade: 'Grade 5', section: 'A', caption: 'Hi', status: 'published' });
  expect(res.status).toBe(201);
  expect(notifyClassPost).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-1', status: 'published' }));
});

test('saving a draft does not notify; publishing it later does', async () => {
  mockSb.setTable('class_portfolio_posts', { data: { ...ROW, status: 'draft' }, error: null });
  await request(app).post('/class-portfolio/posts')
    .send({ teacherEmail: 'teacher@school.test', grade: 'Grade 5', section: 'A', caption: 'Hi' });
  expect(notifyClassPost).not.toHaveBeenCalled();

  const res = await request(app).post('/class-portfolio/posts/post-1/publish').send({ teacherEmail: 'teacher@school.test' });
  expect(res.status).toBe(200);
  expect(notifyClassPost).toHaveBeenCalledWith(expect.objectContaining({ id: 'post-1', status: 'published' }));
});

test('deleting a post clears its notifications', async () => {
  mockSb.setTable('class_portfolio_posts', { data: { ...ROW, status: 'published' }, error: null });
  const res = await request(app).delete('/class-portfolio/posts/post-1').send({ teacherEmail: 'teacher@school.test' });
  expect(res.status).toBe(200);
  expect(clearClassPostNotifications).toHaveBeenCalledWith('post-1');
});
