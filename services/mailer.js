/**
 * Ported from ai-mentor/server/services/mailer.js — only sendEmail (Resend
 * primary, Gmail SMTP fallback) and sendOwnAccountCredentialsEmail (the one
 * template POST /teachers uses). Other templates (sendCredentialsEmail,
 * sendWelcomeEmail, etc.) intentionally not ported — not used here.
 */
const { Resend } = require('resend');
const nodemailer = require('nodemailer');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_EMAIL = 'Aivorah <noreply@aivorah.ai>';

const gmailTransporter = (!resend && process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      pool: true, maxConnections: 3, maxMessages: 10, rateDelta: 2000, rateLimit: 5,
    })
  : null;

function htmlToPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, ' ')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendEmail({ to, subject, html, replyTo, attachments }, retries = 3) {
  const text = htmlToPlainText(html);

  if (resend) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const { data, error } = await resend.emails.send({
          from: FROM_EMAIL,
          to,
          subject,
          html,
          text,
          ...(replyTo ? { replyTo } : {}),
          ...(attachments ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content })) } : {}),
        });
        if (error) throw new Error(error.message);
        console.log(`[mailer:resend] Sent to ${to} (attempt ${attempt}), id: ${data?.id}`);
        return data;
      } catch (err) {
        console.warn(`[mailer:resend] Attempt ${attempt}/${retries} failed for ${to}: ${err.message}`);
        if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
        else throw err;
      }
    }
  }

  if (gmailTransporter) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const info = await gmailTransporter.sendMail({
          from: `"Aivorah" <${process.env.EMAIL_USER}>`,
          to, subject, html, text,
          replyTo: replyTo || `"Aivorah" <${process.env.EMAIL_USER}>`,
          ...(attachments ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content, encoding: 'base64', contentType: a.contentType })) } : {}),
        });
        console.log(`[mailer:gmail] Sent to ${to} (attempt ${attempt}), messageId: ${info.messageId}`);
        return info;
      } catch (err) {
        console.warn(`[mailer:gmail] Attempt ${attempt}/${retries} failed for ${to}: ${err.message}`);
        if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
        else throw err;
      }
    }
  }

  console.warn(`[mailer] No email provider configured — skipping email to ${to}`);
}

async function sendOwnAccountCredentialsEmail({ to, name, loginId, password, role }) {
  if (!to) return;
  const roleLabel = role === 'teacher' ? 'Teacher' : role === 'parent' ? 'Parent' : 'Student';
  try {
    await sendEmail({
      to,
      subject: `Your Aivorah ${roleLabel} account is ready`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#fff">
          <div style="background:#7C3AED;border-radius:12px;padding:24px 24px 16px;margin-bottom:24px">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
            <p style="margin:8px 0 0;color:#e9d5ff;font-size:14px">${roleLabel} account ready</p>
          </div>

          <p style="font-size:15px;color:#333;margin-bottom:4px">Hi ${name || 'there'}!</p>
          <p style="font-size:14px;color:#555;line-height:1.6">
            Your Aivorah ${roleLabel} account has been created. Here are your login credentials — please save them somewhere safe.
          </p>

          <div style="background:#f5f3ff;border-radius:10px;padding:20px;margin:20px 0;border:1px solid #ddd6fe">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px 0;color:#888;font-size:13px">Login ID</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${loginId}</td></tr>
              <tr><td style="padding:8px 0;color:#888;font-size:13px">Password</td><td style="padding:8px 0;font-family:monospace;font-size:14px;color:#1a1a1a">${password}</td></tr>
            </table>
          </div>

          <p style="font-size:13px;color:#666;line-height:1.6">
            Log in at <a href="https://aivorah.ai" style="color:#7C3AED">aivorah.ai</a>
            using the <strong>Login ID</strong> and <strong>Password</strong> above. Select <em>${roleLabel}</em> on the login screen.
          </p>

          <p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
            This email was sent because a ${roleLabel} account was created for you on Aivorah. If you didn't expect this, please contact support.
          </p>
        </div>
      `,
    });
  } catch (err) {
    console.warn('[mailer] sendOwnAccountCredentialsEmail failed:', err.message);
  }
}

// Ported from ai-mentor/server/services/mailer.js — sent when an access
// request (B2C -> B2B conversion) is approved.
async function sendB2BConversionWelcomeEmail({ to, name, role, schoolName, studentName, grade, section }) {
  if (!to) return;
  const safe = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const isParent = role === 'parent';
  const targetName = safe(name || (isParent ? 'Parent' : 'Student'));
  const school = safe(schoolName || 'Your School');
  const child = safe(studentName || 'your child');
  const classInfo = [grade, section].filter(Boolean).join(' - ');

  const subject = isParent
    ? `Welcome to ${school} on Aivorah — Parent Portal Activated`
    : `Welcome to ${school} on Aivorah — Student Portal Activated`;

  const leadText = isParent
    ? `We are pleased to inform you that ${child ? `<strong>${child}</strong>'s` : 'your child\'s'} profile has been officially verified and linked to <strong>${school}</strong>${classInfo ? ` (${classInfo})` : ''} on the Aivorah digital ecosystem.`
    : `We are pleased to inform you that your student account has been officially verified and linked to <strong>${school}</strong>${classInfo ? ` (${classInfo})` : ''} on the Aivorah digital ecosystem.`;

  const capabilitiesList = isParent
    ? `
      <ul style="padding-left:20px;color:#444;font-size:14px;line-height:1.8;margin:12px 0">
        <li><strong>Real-Time Attendance & Schedule Tracking:</strong> Monitor daily class timetables and live attendance status.</li>
        <li><strong>Teacher Feedback & Gradebook Insights:</strong> Review assignments, quizzes, and personalized academic evaluations.</li>
        <li><strong>Official School Communication:</strong> Receive verified announcements, circulars, and direct teacher correspondence.</li>
        <li><strong>Curriculum-Aligned AI Oversight:</strong> Review your child's learning progression across structured grade milestones.</li>
      </ul>`
    : `
      <ul style="padding-left:20px;color:#444;font-size:14px;line-height:1.8;margin:12px 0">
        <li><strong>Official School Timetable:</strong> Access your live daily schedule, homeroom periods, and class meeting links.</li>
        <li><strong>Teacher-Assigned Challenges & Worksheets:</strong> Complete grade-scoped assignments directly within your portal.</li>
        <li><strong>Class Leaderboard & Analytics:</strong> Track your academic standing and topic mastery alongside your peers.</li>
        <li><strong>Curriculum-Aligned AI Study Companion:</strong> Get 24/7 personalized tutoring synced to your exact school syllabus.</li>
      </ul>`;

  return sendEmail({
    to,
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:580px;margin:0 auto;padding:28px;background:#fff;border:1px solid #eaeaea;border-radius:12px">
        <div style="background:#1E293B;border-radius:10px;padding:24px;margin-bottom:24px">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700">Aivorah</h1>
          <p style="margin:6px 0 0;color:#94A3B8;font-size:13px">Official School Network Connection · ${school}</p>
        </div>
        <p style="font-size:15px;color:#1E293B;margin-bottom:12px">Dear ${targetName},</p>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin-top:0">${leadText}</p>

        <div style="background:#F8FAFC;border-left:4px solid #3B82F6;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0">
          <h3 style="margin:0 0 8px;font-size:14px;color:#1E293B;text-transform:uppercase;letter-spacing:0.5px">Your New B2B Capabilities</h3>
          ${capabilitiesList}
        </div>

        <p style="font-size:14px;color:#475569;line-height:1.6">
          You may log in at any time to explore your connected dashboard. All existing study history has been seamlessly preserved.
        </p>
        <div style="text-align:center;margin:28px 0">
          <a href="https://aivorah.ai" style="display:inline-block;background:#3B82F6;color:#fff;text-decoration:none;padding:12px 32px;border-radius:8px;font-size:14px;font-weight:600">Access School Portal</a>
        </div>
        <p style="font-size:12px;color:#94A3B8;margin-top:32px;border-top:1px solid #F1F5F9;padding-top:16px">
          ${school} · Powered by Aivorah Digital Learning Infrastructure
        </p>
      </div>
    `,
  });
}

module.exports = { sendEmail, sendOwnAccountCredentialsEmail, sendB2BConversionWelcomeEmail };
