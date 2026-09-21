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

module.exports = { sendEmail, sendOwnAccountCredentialsEmail };
