'use strict';

const EMAIL_GATEWAY_URL = 'http://127.0.0.1:2525/api/email/send';
const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_FROM = 'Picture Day <support@calcharterpicts.org>';

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

function toArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function gatewayError(message, outcome, diagnostics = {}) {
  const error = new Error(message);
  error.diagnostics = { outcome, ...diagnostics };
  return error;
}

async function send({ to, subject, text, link, from, replyTo, palette }) {
  const payload = {
    to: toArray(to),
    subject,
    text,
    from: typeof from === 'string' && from.trim() ? from.trim() : DEFAULT_FROM,
    html: toHtml(text, link, palette)
  };
  if (replyTo) payload.replyTo = replyTo;

  let response;
  let body;
  try {
    response = await fetch(EMAIL_GATEWAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    try {
      body = await response.json();
    } catch (error) {
      if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
      body = { error: `non-JSON response (HTTP ${response.status})` };
    }
  } catch (error) {
    const detail = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)
      ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    console.error('EMAIL GATEWAY UNREACHABLE:', detail);
    throw gatewayError(`Email gateway unreachable: ${detail}`, 'unknown');
  }

  if (!response.ok || body?.success !== true) {
    const gatewayReason = typeof body?.error === 'string' ? body.error.slice(0, 200) : 'request rejected';
    console.error('EMAIL GATEWAY SEND ERROR:', {
      status: response.status,
      error: body?.error,
      messageId: body?.messageId
    });
    throw gatewayError(
      `Email gateway rejected the send (HTTP ${response.status}): ${gatewayReason}`,
      body?.success === false ? 'rejected' : 'unknown',
      { status: response.status }
    );
  }

  if (!body.messageId) {
    console.error('EMAIL GATEWAY MISSING MESSAGE ID');
    throw gatewayError('Email gateway reported success but returned no messageId.', 'unknown', {
      status: response.status
    });
  }

  console.log('EMAIL SENT:', body.messageId);
  return {
    messageId: body.messageId,
    outcome: 'accepted',
    diagnostics: { outcome: 'accepted' }
  };
}

async function verify() {
  return true;
}

function diagnosticSummary(result) {
  return result?.response || 'Accepted by email gateway.';
}

module.exports = {
  send,
  verify,
  render,
  diagnosticSummary,
  configured: () => true
};
