'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const mail = require('../lib/mail');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    }
  };
}

test('GoDaddy gateway sends the rendered message without SMTP configuration', async (t) => {
  const smtpVariables = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM'];
  const previousEnvironment = Object.fromEntries(smtpVariables.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of smtpVariables) delete process.env[key];

  let request;
  t.mock.method(global, 'fetch', async (...args) => {
    request = args;
    return response(200, { success: true, messageId: 'gateway-message-id' });
  });

  const result = await mail.send({
    to: 'parent@example.test',
    from: 'Picture Day <photos@example.test>',
    replyTo: 'office@example.test',
    subject: 'Photos for Sample',
    text: 'Hello Sample\n\nhttps://photos.example.test/g/gallery-token',
    link: 'https://photos.example.test/g/gallery-token',
    palette: { primary: '#123456' }
  });

  assert.equal(mail.configured(), true);
  assert.equal(await mail.verify(), true);
  assert.equal(request[0], 'http://127.0.0.1:2525/api/email/send');
  assert.equal(request[1].method, 'POST');
  assert.deepEqual(request[1].headers, { 'content-type': 'application/json' });
  assert.equal(request[1].signal.aborted, false);
  const payload = JSON.parse(request[1].body);
  assert.deepEqual({ ...payload, html: undefined }, {
    to: ['parent@example.test'],
    subject: 'Photos for Sample',
    text: 'Hello Sample\n\nhttps://photos.example.test/g/gallery-token',
    html: undefined,
    replyTo: 'office@example.test'
  });
  assert.match(payload.html, /https:\/\/photos\.example\.test\/g\/gallery-token/);
  assert.doesNotMatch(request[1].body, /photos@example\.test/);
  assert.deepEqual(result, {
    messageId: 'gateway-message-id',
    outcome: 'accepted',
    diagnostics: { outcome: 'accepted' }
  });
});

test('gateway accepts an array of recipients and omits an empty reply-to', async (t) => {
  let payload;
  t.mock.method(global, 'fetch', async (_url, options) => {
    payload = JSON.parse(options.body);
    return response(200, { success: true, messageId: 'array-message-id' });
  });

  await mail.send({
    to: ['one@example.test', 'two@example.test'],
    subject: 'Photos',
    text: 'Message',
    link: 'https://photos.example.test'
  });

  assert.deepEqual(payload.to, ['one@example.test', 'two@example.test']);
  assert.equal(Object.hasOwn(payload, 'replyTo'), false);
});

test('gateway rejection returns useful failure details and marks delivery rejected', async (t) => {
  t.mock.method(global, 'fetch', async () => response(422, {
    success: false,
    error: 'invalid recipient'
  }));
  t.mock.method(console, 'error', () => {});

  await assert.rejects(mail.send({
    to: 'invalid@example.test',
    subject: 'Photos',
    text: 'Message',
    link: 'https://photos.example.test'
  }), (error) => {
    assert.match(error.message, /HTTP 422\): invalid recipient/);
    assert.deepEqual(error.diagnostics, { outcome: 'rejected', status: 422 });
    return true;
  });
});

test('gateway non-JSON responses are reported as unresolved failures', async (t) => {
  t.mock.method(global, 'fetch', async () => response(502, new SyntaxError('invalid JSON')));
  t.mock.method(console, 'error', () => {});

  await assert.rejects(mail.send({
    to: 'parent@example.test',
    subject: 'Photos',
    text: 'Message',
    link: 'https://photos.example.test'
  }), (error) => {
    assert.match(error.message, /HTTP 502\): non-JSON response/);
    assert.equal(error.diagnostics.outcome, 'unknown');
    return true;
  });
});

test('gateway transport failures are reported without SMTP configuration errors', async (t) => {
  t.mock.method(global, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  t.mock.method(console, 'error', () => {});

  await assert.rejects(mail.send({
    to: 'parent@example.test',
    subject: 'Photos',
    text: 'Message',
    link: 'https://photos.example.test'
  }), (error) => {
    assert.match(error.message, /Email gateway unreachable: fetch failed/);
    assert.equal(error.diagnostics.outcome, 'unknown');
    return true;
  });
});

test('gateway request timeouts are reported as unresolved failures', async (t) => {
  t.mock.method(global, 'fetch', async (_url, options) => {
    assert.ok(options.signal);
    const error = new Error('request timed out');
    error.name = 'TimeoutError';
    throw error;
  });
  t.mock.method(console, 'error', () => {});

  await assert.rejects(mail.send({
    to: 'parent@example.test',
    subject: 'Photos',
    text: 'Message',
    link: 'https://photos.example.test'
  }), (error) => {
    assert.match(error.message, /timed out after 30000ms/);
    assert.equal(error.diagnostics.outcome, 'unknown');
    return true;
  });
});

test('gateway success without a message ID is reported as unresolved', async (t) => {
  t.mock.method(global, 'fetch', async () => response(200, { success: true }));
  t.mock.method(console, 'error', () => {});

  await assert.rejects(mail.send({
    to: 'parent@example.test',
    subject: 'Photos',
    text: 'Message',
    link: 'https://photos.example.test'
  }), (error) => {
    assert.match(error.message, /returned no messageId/);
    assert.equal(error.diagnostics.outcome, 'unknown');
    return true;
  });
});
