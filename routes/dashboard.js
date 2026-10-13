/**
 * School Admin Dashboard — overview counts/recent-announcements and the
 * access-requests review queue (B2C -> B2B conversion). GET /school-admin/overview
 * did not exist anywhere before this (not the monolith, not a microservice) —
 * built fresh to match the frontend's Overview type. access-requests is a
 * verbatim port of ai-mentor/server/routes/school-admin.js.
 */
const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { sendB2BConversionWelcomeEmail } = require('../services/mailer');
const { normalizeCurriculum } = require('../services/curriculum');

function effectiveSchoolId(req) {
  if (req.adminScope.scopeType === 'school') return req.adminScope.schoolId;
  return req.query.schoolId || null;
}

// GET /school-admin/overview?adminEmail=
router.get('/overview', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const { data: school, error: sErr } = await supabase
      .from('schools').select('id, name, curriculum, academic_year, contact_email').eq('id', schoolId).maybeSingle();
    if (sErr) throw sErr;
    if (!school) return res.status(404).json({ error: 'School not found' });

    const [{ count: studentCount }, { count: teacherCount }, { count: parentCount }, { data: brandingRows }] = await Promise.all([
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('role', 'student').neq('status', 'archived'),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('role', 'teacher'),
      supabase.from('users').select('id', { count: 'exact', head: true }).eq('school_id', schoolId).eq('role', 'parent'),
      supabase.from('branding_logos').select('name, logo_url').eq('kind', 'school'),
    ]);

    const { data: targetRows } = await supabase.from('announcement_targets').select('announcement_id').eq('school_id', schoolId);
    const announcementIds = [...new Set((targetRows || []).map((t) => t.announcement_id))];

    let counts = { publishedAnnouncements: 0, scheduledAnnouncements: 0, draftAnnouncements: 0 };
    let recentAnnouncements = [];
    if (announcementIds.length) {
      const { data: announcements } = await supabase
        .from('announcements')
        .select('id, title, severity, status, created_at, starts_at')
        .in('id', announcementIds)
        .order('created_at', { ascending: false });
      for (const a of announcements || []) {
        if (a.status === 'published') counts.publishedAnnouncements++;
        else if (a.status === 'scheduled') counts.scheduledAnnouncements++;
        else if (a.status === 'draft') counts.draftAnnouncements++;
      }
      recentAnnouncements = (announcements || []).slice(0, 5).map((a) => ({
        id: a.id, title: a.title, severity: a.severity, status: a.status,
        createdAt: a.created_at, startsAt: a.starts_at,
      }));
    }

    const norm = (s) => String(s || '').trim().toLowerCase();
    const logoUrl = (brandingRows || []).find((r) => norm(r.name) === norm(school.name))?.logo_url || null;

    res.json({
      school: {
        id: school.id, name: school.name, curriculum: normalizeCurriculum(school.curriculum) || null, logoUrl,
        academicYear: school.academic_year || '', contactEmail: school.contact_email || '',
      },
      counts: {
        students: studentCount ?? 0,
        teachers: teacherCount ?? 0,
        parents: parentCount ?? 0,
        ...counts,
      },
      recentAnnouncements,
    });
  } catch (err) {
    console.error('[GET /school-admin/overview] error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard overview' });
  }
});

// GET /school-admin/access-requests?adminEmail=[&status=pending]
router.get('/access-requests', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  const status = req.query.status || 'pending';
  try {
    const { data: reqs, error } = await supabase
      .from('school_access_requests')
      .select('id, user_email, grade, section, status, created_at')
      .eq('school_id', schoolId).eq('status', status)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Decorate each request with the full picture the admin needs to decide:
    // the requester's identity (name/role/grade/curriculum/phone/age), their
    // under-14 consent requirements, and — for a student — their linked parent(s).
    const emails = [...new Set((reqs || []).map((r) => r.user_email))];
    const userMap = new Map();       // email -> { id, name, role, grade, curriculum, phone, created_at }
    const prefMap = new Map();       // email -> { age, dateOfBirth, parentConsentStatus }
    if (emails.length) {
      const [{ data: users }, { data: prefs }] = await Promise.all([
        supabase.from('users').select('id, email, name, role, grade, curriculum, phone, created_at').in('email', emails),
        supabase.from('user_preferences').select('user_email, data').in('user_email', emails),
      ]);
      for (const u of users || []) userMap.set(u.email, u);
      for (const p of prefs || []) prefMap.set(p.user_email, p.data || {});
    }

    // Resolve linked parents for the student requesters. parent_children links a
    // parent_email to a child_id (the student's users.id); we then resolve each
    // parent_email to a display name + phone.
    const studentIds = [...new Set([...userMap.values()].filter((u) => u.role === 'student').map((u) => u.id))];
    const parentsByChildId = new Map(); // child_id -> [{ name, email, phone }]
    if (studentIds.length) {
      const { data: links } = await supabase
        .from('parent_children').select('child_id, parent_email').in('child_id', studentIds);
      const parentEmails = [...new Set((links || []).map((l) => l.parent_email))];
      const parentMap = new Map();
      if (parentEmails.length) {
        const { data: parents } = await supabase.from('users').select('email, name, phone').in('email', parentEmails);
        for (const p of parents || []) parentMap.set(p.email, p);
      }
      for (const l of links || []) {
        if (!parentsByChildId.has(l.child_id)) parentsByChildId.set(l.child_id, []);
        const pInfo = parentMap.get(l.parent_email) || {};
        parentsByChildId.get(l.child_id).push({ email: l.parent_email, name: pInfo.name || null, phone: pInfo.phone || null });
      }
    }

    res.json((reqs || []).map((r) => {
      const u = userMap.get(r.user_email);
      const pref = prefMap.get(r.user_email) || {};
      const parents = u ? (parentsByChildId.get(u.id) || []) : [];

      // Calculate or estimate age from profile preferences or grade level
      let age = pref.age || null;
      if (!age && pref.dateOfBirth) {
        const dob = new Date(pref.dateOfBirth);
        if (!isNaN(dob.getTime())) {
          age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        }
      }
      // If age not explicitly provided, estimate from requested/current grade
      const gStr = String(r.grade || u?.grade || '').toLowerCase();
      let isUnder14 = age !== null ? age < 14 : true;
      if (age === null && (gStr.includes('myp 4') || gStr.includes('myp 5') || gStr.includes('dp') || gStr.includes('grade 9') || gStr.includes('grade 10') || gStr.includes('grade 11') || gStr.includes('grade 12'))) {
        isUnder14 = false;
      }

      // Determine parent consent status (< 14 vs >= 14)
      let parentConsentStatus = pref.parentConsentStatus || null;
      if (!parentConsentStatus) {
        if (isUnder14) {
          parentConsentStatus = parents.length > 0 ? 'approved_by_parent' : 'pending_parent_verification';
        } else {
          parentConsentStatus = parents.length > 0 ? 'student_initiated_with_parent' : 'student_initiated_independent';
        }
      }

      return {
        ...r,
        name: u?.name || null,
        role: u?.role || null,
        phone: u?.phone || null,
        age,
        isUnder14,
        parentConsentStatus,
        userCreatedAt: u?.created_at || null,
        studentGrade: u?.grade || null,
        curriculum: normalizeCurriculum(u?.curriculum) || null,
        parents,
      };
    }));
  } catch (err) {
    console.error('[GET /school-admin/access-requests] error:', err.message);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

// POST /school-admin/access-requests/:id/approve  { adminEmail }
// Links the requester and all linked parents to this school (B2C → B2B cascade)
// and sends professional welcome notifications via Resend.
router.post('/access-requests/:id/approve', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const { data: reqRow, error: rErr } = await supabase
      .from('school_access_requests').select('*').eq('id', req.params.id).maybeSingle();
    if (rErr) throw rErr;
    if (!reqRow) return res.status(404).json({ error: 'Request not found' });
    // Ownership guard: an admin can only action requests for their own school.
    if (reqRow.school_id !== schoolId) return res.status(403).json({ error: 'Not authorized for this request' });
    if (reqRow.status !== 'pending') return res.status(409).json({ error: `Request already ${reqRow.status}` });

    // Look up school name and user record for cascade & notification
    const [{ data: schoolRow }, { data: userRow }] = await Promise.all([
      supabase.from('schools').select('name').eq('id', schoolId).maybeSingle(),
      supabase.from('users').select('id, name, role').eq('email', reqRow.user_email).maybeSingle(),
    ]);
    const schoolName = schoolRow?.name || 'Your School';

    // Link the user to the school AND place them in the requested grade+section
    const patch = { school_id: schoolId, school: schoolName };
    if (reqRow.grade) patch.grade = reqRow.grade;
    if (reqRow.section) patch.section = reqRow.section;
    const { error: uErr } = await supabase.from('users').update(patch).eq('email', reqRow.user_email);
    if (uErr) throw uErr;

    // Also update preferences data with school details
    const { data: prefRow } = await supabase.from('user_preferences').select('data').eq('user_email', reqRow.user_email).maybeSingle();
    const updatedPref = { ...(prefRow?.data || {}), school: schoolName, schoolId, accountStatus: 'active' };
    await supabase.from('user_preferences').upsert({ user_email: reqRow.user_email, data: updatedPref });

    // ── Cascade to linked parents (if requester is a student) ──────────────────
    let linkedParents = [];
    if (userRow && userRow.role === 'student' && userRow.id) {
      const { data: parentLinks } = await supabase.from('parent_children').select('parent_email').eq('child_id', userRow.id);
      if (parentLinks && parentLinks.length > 0) {
        const parentEmails = parentLinks.map(l => l.parent_email).filter(Boolean);
        if (parentEmails.length > 0) {
          // Link all parents to this school as B2B parent accounts
          await supabase.from('users').update({ school_id: schoolId, school: schoolName }).in('email', parentEmails);
          const { data: parentUsers } = await supabase.from('users').select('name, email').in('email', parentEmails);
          linkedParents = parentUsers || [];
          for (const p of linkedParents) {
            const { data: pPref } = await supabase.from('user_preferences').select('data').eq('user_email', p.email).maybeSingle();
            await supabase.from('user_preferences').upsert({
              user_email: p.email,
              data: { ...(pPref?.data || {}), school: schoolName, schoolId, accountStatus: 'active' },
            });
          }
        }
      }
    }

    const { error: sErr } = await supabase.from('school_access_requests')
      .update({ status: 'approved', reviewed_by: req.adminEmail, reviewed_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (sErr) throw sErr;

    // ── Send Professional Welcome Notifications via Resend ─────────────────────
    sendB2BConversionWelcomeEmail({
      to: reqRow.user_email,
      name: userRow?.name || null,
      role: userRow?.role || 'student',
      schoolName,
      grade: reqRow.grade,
      section: reqRow.section,
    }).catch(err => console.error('[approve request] failed to send student welcome email:', err.message));

    for (const p of linkedParents) {
      sendB2BConversionWelcomeEmail({
        to: p.email,
        name: p.name || 'Parent',
        role: 'parent',
        schoolName,
        studentName: userRow?.name || 'your child',
        grade: reqRow.grade,
        section: reqRow.section,
      }).catch(err => console.error('[approve request] failed to send parent welcome email:', err.message));
    }

    res.json({ ok: true, status: 'approved', cascadedParents: linkedParents.length });
  } catch (err) {
    console.error('[POST /school-admin/access-requests/:id/approve] error:', err.message);
    res.status(500).json({ error: 'Failed to approve request' });
  }
});

// POST /school-admin/access-requests/:id/reject  { adminEmail }
router.post('/access-requests/:id/reject', async (req, res) => {
  const schoolId = effectiveSchoolId(req);
  if (!schoolId) return res.status(400).json({ error: 'schoolId required for platform admins' });
  try {
    const { data: reqRow, error: rErr } = await supabase
      .from('school_access_requests').select('id, school_id, status').eq('id', req.params.id).maybeSingle();
    if (rErr) throw rErr;
    if (!reqRow) return res.status(404).json({ error: 'Request not found' });
    if (reqRow.school_id !== schoolId) return res.status(403).json({ error: 'Not authorized for this request' });
    if (reqRow.status !== 'pending') return res.status(409).json({ error: `Request already ${reqRow.status}` });

    const { error } = await supabase.from('school_access_requests')
      .update({ status: 'rejected', reviewed_by: req.adminEmail, reviewed_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true, status: 'rejected' });
  } catch (err) {
    console.error('[POST /school-admin/access-requests/:id/reject] error:', err.message);
    res.status(500).json({ error: 'Failed to reject request' });
  }
});

module.exports = router;
