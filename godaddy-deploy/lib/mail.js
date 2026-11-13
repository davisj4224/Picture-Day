'use strict';

const nodemailer = require('nodemailer');

let cached = null;

function transport() {
  if (cached) return cached;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  if (!SMTP_HOST) return null;
  cached = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE || 'false') === 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  });
  return cached;
}

function render(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key])
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function toHtml(text, link, palette) {
  const body = escapeHtml(text)
    .split('\n\n')
    .map((paragraph) => `<p style="margin:0 0 16px;line-height:1.55">${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#16202B;max-width:34em">
  ${body.replace(
    escapeHtml(link),
    `<a href="${escapeHtml(link)}" style="display:inline-block;padding:11px 18px;background:${
      palette?.primary || '#16505C'
    };color:#fff;text-decoration:none;border-radius:6px">View the photos</a>`
  )}
</div>`;
}

async function send({ to, subject, text, link, from, replyTo, palette }) {
  const currentTransport = transport();
  if (!currentTransport) {
    throw new Error('SMTP is not configured. Add SMTP_HOST and related values to .env, or use the CSV export instead.');
  }
  return currentTransport.sendMail({
    from,
    to,
    replyTo: replyTo || undefined,
    subject,
    text,
    html: toHtml(text, link, palette)
  });
}

async function verify() {
  const currentTransport = transport();
  if (!currentTransport) throw new Error('SMTP is not configured.');
  return currentTransport.verify();
}

function diagnosticSummary(result) {
  return result?.response || 'Accepted by SMTP transport.';
}

module.exports = {
  send,
  verify,
  render,
  diagnosticSummary,
  configured: () => Boolean(process.env.SMTP_HOST)
};
