'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { parentEmailOperationGuard } = require('../lib/parent-email-availability');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function invokeGuard(method, requestPath, hostname, configuredPublishedUrl) {
  let statusCode;
  let responseBody;
  let continued = false;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };
  parentEmailOperationGuard(
    { method, path: requestPath, hostname },
    response,
    () => { continued = true; },
    configuredPublishedUrl
  );
  return { statusCode, responseBody, continued };
}

test('server mounts a fail-closed Published-host guard for queue and all email operations', () => {
  const previousHost = process.env.PARENT_EMAIL_PUBLISHED_HOST;
  const protectedOperations = [
    ['POST', '/api/projects/8/email/preview'],
    ['POST', '/api/projects/8/email/send'],
    ['GET', '/api/projects/8/email/queue'],
    ['POST', '/api/projects/8/email/queue/12/remove'],
    ['POST', '/api/projects/8/email/send-all'],
    ['POST', '/api/projects/8/email/queue/12/retry'],
    ['POST', '/api/projects/8/email/queue/12/retry-unresolved'],
    ['POST', '/api/students/12/resend-gallery-email'],
    ['POST', '/api/email/send'],
    ['POST', '/api/email/test']
  ];

  try {
    delete process.env.PARENT_EMAIL_PUBLISHED_HOST;
    for (const [method, requestPath] of protectedOperations) {
      const blocked = invokeGuard(method, requestPath, 'published.example.test');
      assert.equal(blocked.statusCode, 503, `${method} ${requestPath} must fail closed without configuration`);
      assert.equal(blocked.continued, false);
      assert.match(blocked.responseBody.error, /PARENT_EMAIL_PUBLISHED_HOST/);
    }

    process.env.PARENT_EMAIL_PUBLISHED_HOST = 'https://Published.Example.Test:443/';
    const preview = invokeGuard('POST', '/api/projects/8/email/preview', 'preview.example.test');
    assert.equal(preview.statusCode, 503, 'Preview hostname cannot persist queue records');
    assert.equal(preview.continued, false);

    for (const [method, requestPath] of protectedOperations) {
      const allowed = invokeGuard(method, requestPath, 'published.example.test');
      assert.equal(allowed.continued, true, `${method} ${requestPath} should allow the configured Published host`);
      assert.equal(allowed.statusCode, undefined);
    }

    const urlWithPort = invokeGuard('POST', '/api/projects/8/email/preview', 'published.example.test');
    assert.equal(urlWithPort.continued, true, 'scheme, port, and case in the configured URL do not hide the Published hostname');
    delete process.env.PARENT_EMAIL_PUBLISHED_HOST;
    assert.equal(
      invokeGuard('POST', '/api/projects/8/email/preview', 'calcharterpicts.org', 'https://calcharterpicts.org/').continued,
      true,
      'the configured family-facing URL identifies the Published hostname'
    );
    assert.equal(
      invokeGuard('POST', '/api/projects/8/email/preview', 'preview.calcharterpicts.org', 'https://calcharterpicts.org/').statusCode,
      503,
      'Preview remains blocked when its hostname differs from the family-facing URL'
    );
    assert.equal(invokeGuard('GET', '/api/projects/8/email/attempts', 'preview.example.test').continued, true);
    assert.equal(invokeGuard('GET', '/api/projects/8/email/recipients', 'preview.example.test').continued, true);
    assert.match(serverSource, /parentEmailOperationGuard\(req, res, next, config\(\)\.publicUrl\)/);
    assert.ok(
      serverSource.indexOf('parentEmailOperationGuard(req, res, next, config().publicUrl)') <
        serverSource.indexOf("app.post('/api/projects/:id/email/preview'"),
      'the guard must be registered before email routes'
    );
    assert.match(serverSource, /if \(req\.body\?\.confirmUnresolved !== true\)/);
    assert.match(serverSource, /historicalProjectEmailState\(history\)/);
  } finally {
    if (previousHost === undefined) delete process.env.PARENT_EMAIL_PUBLISHED_HOST;
    else process.env.PARENT_EMAIL_PUBLISHED_HOST = previousHost;
  }
});
