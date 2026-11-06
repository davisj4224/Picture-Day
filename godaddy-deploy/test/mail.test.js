'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const mail = require('../lib/mail');

const message = {
  to: 'parent.person@gmail.com',
  subject: 'Private subject for a student',
  text: 'Private gallery message body',
  link: 'https://photos.example.test/p/secret-token',
  palette: { primary: '#123456' }
};

function mockResponse({ ok = true, status = 200, body }) {
  return {
    ok,
    status,
    async json() {
      return body;
    }
  };
}

async function withoutConsoleLogs(callback) {
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = () => {};
  console.error = () => {};
  try {
    return await callback();
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
}

test('gateway success records masked recipient and acceptance without claiming inbox delivery', async () => {
  const result = await withoutConsoleLogs(() => mail.send(message, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:2525/api/email/send');
      assert.equal(options.method, 'POST');
      return mockResponse({
        body: {
          success: true,
          messageId: 'gateway-id-123',
          smtpCode: 250,
          smtpResponse: '250 message accepted'
        }
      });
    }
  }));

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.messageId, 'gateway-id-123');
  assert.equal(result.diagnostics.smtpCode, 250);
  assert.equal(result.diagnostics.recipients[0].recipient, 'p***@gmail.com');
  assert.equal(result.diagnostics.recipients[0].domain, 'gmail.com');
  assert.match(mail.diagnosticSummary(result.diagnostics), /inbox delivery is unknown/);
  assert.equal(JSON.stringify(result.diagnostics).includes(message.subject), false);
  assert.equal(JSON.stringify(result.diagnostics).includes(message.text), false);
  assert.equal(JSON.stringify(result.diagnostics).includes('parent.person@gmail.com'), false);
});

test('SMTP rejection response is preserved and sensitive text is redacted', async () => {
  const error = await withoutConsoleLogs(() => assert.rejects(
    mail.send(message, {
      fetchImpl: async () => mockResponse({
        ok: false,
        status: 502,
        body: {
          success: false,
          smtpCode: 550,
          smtpResponse: '550 rejected parent.person@gmail.com password=DoNotStore'
        }
      })
    }),
    (caught) => {
      assert.equal(caught.name, 'EmailDeliveryError');
      assert.equal(caught.diagnostics.outcome, 'rejected');
      assert.equal(caught.diagnostics.smtpCode, 550);
      assert.doesNotMatch(caught.diagnostics.smtpResponse, /parent\.person@gmail\.com|DoNotStore/);
      assert.match(caught.diagnostics.smtpResponse, /\[redacted-email\]/);
      assert.match(caught.diagnostics.smtpResponse, /password=\[redacted\]/);
      assert.match(caught.message, /SMTP rejected.*550/);
      return true;
    }
  ));
  assert.equal(error, undefined);
});

test('gateway failures without an SMTP result remain unknown', async () => {
  await withoutConsoleLogs(() => assert.rejects(
    mail.send(message, {
      fetchImpl: async () => mockResponse({
        ok: false,
        status: 502,
        body: { success: false, error: 'Upstream service unavailable' }
      })
    }),
    (error) => {
      assert.equal(error.diagnostics.outcome, 'unknown');
      assert.equal(error.diagnostics.gatewayHttpStatus, 502);
      assert.equal(error.diagnostics.unknownReason, 'gateway_did_not_confirm_smtp_result');
      assert.equal(error.diagnostics.gatewayMessage, 'Upstream service unavailable');
      return true;
    }
  ));
});

test('timeout and connection errors record an unknown result and transport code', async () => {
  await withoutConsoleLogs(() => assert.rejects(
    mail.send(message, {
      fetchImpl: async () => {
        const error = new Error('connection interrupted');
        error.name = 'TimeoutError';
        error.code = 'ECONNRESET';
        throw error;
      }
    }),
    (error) => {
      assert.equal(error.diagnostics.outcome, 'unknown');
      assert.equal(error.diagnostics.unknownReason, 'timeout_or_abort');
      assert.equal(error.diagnostics.errorType, 'TimeoutError');
      assert.equal(error.diagnostics.errorCode, 'ECONNRESET');
      return true;
    }
  ));
});
