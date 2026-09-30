'use strict';

const EMAIL_GATEWAY_URL = 'http://127.0.0.1:2525/api/email/send';
const REQUEST_TIMEOUT_MS = 30000;

function render(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] === undefined || vars[key] === null ? '' : String(vars[key])
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function toHtml(text, link, palette) {
  const body = escapeHtml(text)
    .split('\n\n')
    .map((p) => `<p style="margin:0 0 16px;line-height:1.55">${p.replace(/\n/g, '<br>')}</p>`)
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

function toArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function send({ to, subject, text, link, replyTo, palette }) {
  const payload = {
    to: toArray(to),
    subject,
    text,
    html: toHtml(text, link, palette)
  };

  if (replyTo) {
    payload.replyTo = replyTo;
  }

  let response;
  let body;

  try {
    response = await fetch(EMAIL_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    try {
      body = await response.json();
    } catch (err) {
      if (err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw err;
      }

      body = {
        success: false,
        error: `non-JSON response (HTTP ${response.status})`
      };
    }
  } catch (err) {
    const message =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError')
        ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);

    console.error('EMAIL GATEWAY UNREACHABLE:', message);
    throw new Error('Email gateway unreachable.');
  }

  if (!response.ok || !body.success) {
    console.error('EMAIL GATEWAY SEND ERROR:', {
      status: response.status,
      error: body.error,
      messageId: body.messageId
    });

    throw new Error('Email send failed.');
  }

  if (!body.messageId) {
    console.error('EMAIL GATEWAY MISSING MESSAGE ID');
    throw new Error('Email send succeeded but gateway returned no messageId.');
  }

  console.log('EMAIL SENT:', body.messageId);

  return {
    messageId: body.messageId
  };
}

async function verify() {
  // There is no SMTP connection to verify.
  // The actual gateway is exercised when send() is called.
  return true;
}

module.exports = {
  send,
  verify,
  render,
  configured: () => true
};
