'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const nodemailer = require('nodemailer');
const mail = require('../lib/mail');

test('launch SMTP transport sends the original rendered message over configured SMTP', async (t) => {
  const originalEnvironment = Object.fromEntries(
    ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE'].map((key) => [key, process.env[key]])
  );
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  Object.assign(process.env, {
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '465',
    SMTP_USER: 'mailer@example.test',
    SMTP_PASS: 'not-a-real-password',
    SMTP_SECURE: 'true'
  });

  let transportOptions;
  let message;
  const transport = {
    async sendMail(input) {
      message = input;
      return { messageId: 'message-id', response: '250 accepted' };
    },
    async verify() {
      return true;
    }
  };
  t.mock.method(nodemailer, 'createTransport', (options) => {
    transportOptions = options;
    return transport;
  });

  const result = await mail.send({
    to: 'parent@example.test',
    from: 'Picture Day <photos@example.test>',
    replyTo: 'office@example.test',
    subject: 'Photos for {{student}}',
    text: 'Hello Sample\n\nhttps://photos.example.test/g/gallery-token',
    link: 'https://photos.example.test/g/gallery-token',
    palette: { primary: '#123456' }
  });

  assert.deepEqual(transportOptions, {
    host: 'smtp.example.test',
    port: 465,
    secure: true,
    auth: { user: 'mailer@example.test', pass: 'not-a-real-password' }
  });
  assert.equal(message.from, 'Picture Day <photos@example.test>');
  assert.equal(message.to, 'parent@example.test');
  assert.equal(message.replyTo, 'office@example.test');
  assert.equal(message.subject, 'Photos for {{student}}');
  assert.match(message.html, /https:\/\/photos\.example\.test\/g\/gallery-token/);
  assert.equal(result.messageId, 'message-id');
  assert.equal(await mail.verify(), true);
  assert.equal(mail.configured(), true);
});
