'use strict';

const EMAIL_GATEWAY_URL = 'http://127.0.0.1:2525/api/email/send';
const REQUEST_TIMEOUT_MS = 30000;

class EmailDeliveryError extends Error {
  constructor(message, diagnostics) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.code = diagnostics.errorCode || null;
    this.diagnostics = diagnostics;
  }
}

function maskRecipient(value) {
  const address = String(value || '').trim();
  const at = address.lastIndexOf('@');
  if (at < 1) return address ? '[redacted]' : null;
  const local = address.slice(0, at);
  return `${local[0]}***@${address.slice(at + 1)}`;
}

function safeDiagnosticText(value) {
  if (typeof value !== 'string') return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b(password|pass|secret|token|authorization|api[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^,\s;]+)/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

function smtpCodeFrom(body) {
  const candidate = body?.smtpCode ?? body?.smtpResponseCode ?? body?.responseCode ?? body?.smtp?.code;
  const numeric = Number(candidate);
  if (Number.isInteger(numeric) && numeric >= 200 && numeric <= 599) return numeric;
  const response = body?.smtpResponse ?? body?.response ?? body?.smtp?.response;
  const match = typeof response === 'string' && response.match(/^\s*(\d{3})\b/);
  return match ? Number(match[1]) : null;
}

function deliveryDiagnostics({ to, body = {}, httpStatus = null, error = null, accepted = false }) {
  const smtpCode = smtpCodeFrom(body);
  const outcome = smtpCode >= 400 || body?.smtpRejected === true
    ? 'rejected'
    : accepted
      ? 'accepted'
      : 'unknown';
  const recipients = toArray(to).map((recipient) => {
    const address = String(recipient || '').trim();
    const at = address.lastIndexOf('@');
    return {
      recipient: maskRecipient(address),
      domain: at > 0 ? address.slice(at + 1).toLowerCase() : null
    };
  });
  const gatewayMessage = safeDiagnosticText(
    typeof body?.error === 'string'
      ? body.error
      : typeof body?.message === 'string'
        ? body.message
        : null
  );
  const smtpResponse = safeDiagnosticText(
    typeof body?.smtpResponse === 'string'
      ? body.smtpResponse
      : typeof body?.smtp?.response === 'string'
        ? body.smtp.response
        : null
  );
  return {
    timestamp: new Date().toISOString(),
    outcome,
    recipients,
    smtpCode,
    smtpResponse,
    gatewayHttpStatus: httpStatus,
    errorCode: typeof (error?.code || error?.cause?.code || body?.errorCode || body?.code) === 'string'
      ? String(error?.code || error?.cause?.code || body.errorCode || body.code).slice(0, 64)
      : null,
    errorType: typeof (error?.name || body?.errorType || body?.type) === 'string'
      ? String(error?.name || body.errorType || body.type).slice(0, 64)
      : null,
    transportMessage: safeDiagnosticText(error?.message),
    gatewayMessage,
    messageId: accepted && typeof body?.messageId === 'string' ? body.messageId.slice(0, 255) : null,
    unknownReason: outcome === 'unknown'
      ? error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'timeout_or_abort'
        : error
          ? 'connection_or_request_error'
          : httpStatus !== null
            ? 'gateway_did_not_confirm_smtp_result'
            : 'gateway_did_not_confirm_smtp_result'
      : null
  };
}

function diagnosticSummary(diagnostics) {
  if (diagnostics.outcome === 'accepted') return 'Accepted by email gateway; inbox delivery is unknown.';
  if (diagnostics.outcome === 'rejected') {
    const detail = diagnostics.smtpResponse || diagnostics.gatewayMessage;
    return `SMTP rejected the message${diagnostics.smtpCode ? ` (${diagnostics.smtpCode})` : ''}${detail ? `: ${detail}` : '.'}`;
  }
  const detail = diagnostics.errorCode || diagnostics.errorType || diagnostics.transportMessage ||
    diagnostics.gatewayMessage || diagnostics.unknownReason;
  return `Email outcome unknown${detail ? `: ${detail}` : '.'}`;
}

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

async function send({ to, subject, text, link, replyTo, palette }, { fetchImpl = globalThis.fetch } = {}) {
  const payload = {
    to: toArray(to),
    subject,
    text,
    from: 'Picture Day <support@calcharterpicts.org>',
    html: toHtml(text, link, palette)
  };

  if (replyTo) {
    payload.replyTo = replyTo;
  }

  let response;
  let body;

  try {
    response = await fetchImpl(EMAIL_GATEWAY_URL, {
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      body = { success: false, error: 'email gateway returned an invalid response' };
    }
  } catch (err) {
    const diagnostics = deliveryDiagnostics({ to, error: err, httpStatus: response?.status ?? null });
    console.error('[email] delivery outcome', diagnostics);
    throw new EmailDeliveryError(diagnosticSummary(diagnostics), diagnostics);
  }

  if (!response.ok || !body.success) {
    const diagnostics = deliveryDiagnostics({ to, body, httpStatus: response.status });
    console.error('[email] delivery outcome', diagnostics);
    throw new EmailDeliveryError(diagnosticSummary(diagnostics), diagnostics);
  }

  if (!body.messageId) {
    const diagnostics = deliveryDiagnostics({ to, body, httpStatus: response.status });
    console.error('[email] delivery outcome', diagnostics);
    throw new EmailDeliveryError(diagnosticSummary(diagnostics), diagnostics);
  }

  const diagnostics = deliveryDiagnostics({ to, body, httpStatus: response.status, accepted: true });
  console.info('[email] delivery outcome', diagnostics);
  if (diagnostics.outcome === 'rejected') {
    throw new EmailDeliveryError(diagnosticSummary(diagnostics), diagnostics);
  }

  return {
    messageId: body.messageId,
    outcome: diagnostics.outcome,
    diagnostics
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
  diagnosticSummary,
  configured: () => true
};
