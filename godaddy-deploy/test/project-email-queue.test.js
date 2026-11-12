'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  deliverQueueRecipients,
  persistProjectEmailPreviews
} = require('../lib/project-email-queue');

function harness(initialRecipients, initialFailures = new Map()) {
  const recipients = initialRecipients.map((recipient) => ({ ...recipient }));
  const sent = [];
  const failures = new Map(initialFailures);
  return {
    recipients,
    sent,
    failures,
    async claim(id, expectedStatus) {
      const recipient = recipients.find((item) => item.id === id);
      if (!recipient || recipient.status !== expectedStatus) return false;
      recipient.status = 'sending';
      return id;
    },
    async send(recipient) {
      sent.push({
        studentId: recipient.student_id,
        to: recipient.recipient_email,
        subject: recipient.subject,
        body: recipient.body,
        link: recipient.gallery_link
      });
      if (failures.has(recipient.id)) {
        const outcome = failures.get(recipient.id);
        const error = new Error(`gateway ${outcome}`);
        error.diagnostics = { outcome };
        throw error;
      }
      return { outcome: 'accepted', messageId: `message-${recipient.id}`, diagnostics: { outcome: 'accepted' } };
    },
    async record(recipient, status, delivery, error) {
      recipient.status = status;
      recipient.outcome = delivery?.outcome || error?.diagnostics?.outcome;
      recipient.error = error?.message || null;
    }
  };
}

function persistenceHarness(initialAttempts = []) {
  const items = new Map();
  const recipients = [];
  const attempts = initialAttempts.map((attempt) => ({ ...attempt }));
  const db = {
    async transaction(callback) {
      return callback({
        prepare(sql) {
          return {
            async run(...values) {
              if (sql.includes('INSERT INTO project_email_queue_items')) {
                const key = `${values[0]}:${values[1]}`;
                const existing = items.get(key);
                items.set(key, {
                  id: existing?.id || items.size + 1,
                  projectId: values[0],
                  studentId: values[1],
                  subject: values[2],
                  body: values[3],
                  galleryLink: values[4]
                });
              } else if (sql.includes('INSERT INTO project_email_queue_recipients')) {
                const [queueItemId, email] = values;
                const existing = recipients.find((recipient) =>
                  recipient.queueItemId === queueItemId &&
                  recipient.email.toLowerCase() === email.toLowerCase()
                );
                if (!existing) recipients.push({ queueItemId, email, status: 'queued' });
                else if (existing.status === 'excluded') existing.status = 'queued';
              } else if (sql.includes('UPDATE project_email_queue_recipients')) {
                const [status, attemptedAt, error, outcome, diagnostics, messageId, attemptId, queueItemId, email] = values;
                const recipient = recipients.find((item) =>
                  item.queueItemId === queueItemId &&
                  item.email.toLowerCase() === email.toLowerCase()
                );
                if (recipient && recipient.status !== 'sending') {
                  Object.assign(recipient, {
                    status,
                    attemptedAt,
                    error,
                    outcome,
                    diagnostics,
                    messageId,
                    attemptId
                  });
                }
              }
            },
            async get(projectId, studentId) {
              return items.get(`${projectId}:${studentId}`);
            },
            async all(projectId, studentId, email) {
              if (!sql.includes('FROM gallery_email_attempts')) return [];
              return attempts.filter((attempt) =>
                attempt.projectId === projectId &&
                attempt.studentId === studentId &&
                attempt.emailType === 'project-gallery' &&
                attempt.recipientEmail.toLowerCase() === email.toLowerCase()
              );
            }
          };
        }
      });
    }
  };
  return { db, items, recipients, attempts };
}

test('persisting previews creates one saved, student-specific queue item without a delivery dependency', async () => {
  const { db, items, recipients } = persistenceHarness();
  const previews = [
    { studentId: 12, subject: 'Student 12', text: 'Gallery 12', galleryLink: '/p/12',
      recipientEmails: ['parent12@example.test', 'guardian12@example.test'] },
    { studentId: 13, subject: 'Student 13', text: 'Gallery 13', galleryLink: '/p/13',
      recipientEmails: ['parent13@example.test'] }
  ];

  await persistProjectEmailPreviews(db, 8, previews, 10);
  assert.equal(items.size, 2);
  assert.deepEqual(recipients.map(({ queueItemId, email }) => ({ queueItemId, email })), [
    { queueItemId: 1, email: 'parent12@example.test' },
    { queueItemId: 1, email: 'guardian12@example.test' },
    { queueItemId: 2, email: 'parent13@example.test' }
  ]);
  assert.equal(items.get('8:12').galleryLink, '/p/12');
  assert.equal(items.get('8:13').galleryLink, '/p/13');

  recipients[0].status = 'accepted';
  recipients[1].status = 'excluded';
  await persistProjectEmailPreviews(db, 8, previews, 11);
  assert.equal(items.size, 2, 're-preview updates the existing gallery queue items');
  assert.equal(recipients[0].status, 'accepted', 're-preview never resets an accepted recipient');
  assert.equal(recipients[1].status, 'queued', 'a newly eligible excluded recipient can be queued again');
});

test('preview reconciles historical accepted, rejected, and uncertain attempts without changing history', async () => {
  const attempts = [
    { id: 25, projectId: 8, studentId: 12, recipientEmail: 'parent12@example.test', emailType: 'project-gallery',
      attempted_at: 130, status: 'unresolved', outcome: 'unknown', error_message: 'Later timeout',
      diagnostic_json: '{"outcome":"unknown"}', message_id: null },
    { id: 21, projectId: 8, studentId: 12, recipientEmail: 'parent12@example.test', emailType: 'project-gallery',
      attempted_at: 100, status: 'sent', outcome: 'accepted', error_message: null,
      diagnostic_json: '{"outcome":"accepted"}', message_id: 'accepted-21' },
    { id: 22, projectId: 8, studentId: 12, recipientEmail: 'failed12@example.test', emailType: 'project-gallery',
      attempted_at: 110, status: 'failed', outcome: 'rejected', error_message: 'SMTP rejected',
      diagnostic_json: '{"outcome":"rejected"}', message_id: null },
    { id: 23, projectId: 8, studentId: 12, recipientEmail: 'unknown12@example.test', emailType: 'project-gallery',
      attempted_at: 120, status: 'unresolved', outcome: 'unknown', error_message: 'No gateway response',
      diagnostic_json: '{"outcome":"unknown"}', message_id: null },
    { id: 24, projectId: 8, studentId: 12, recipientEmail: 'legacy12@example.test', emailType: 'project-gallery',
      attempted_at: 90, status: 'failed', outcome: null, error_message: null,
      diagnostic_json: null, message_id: null }
  ];
  const originalAttempts = structuredClone(attempts);
  const store = persistenceHarness(attempts);
  const previews = [{
    studentId: 12,
    subject: 'Student 12',
    text: 'Gallery 12',
    galleryLink: '/p/12',
    recipientEmails: [
      'PARENT12@example.test',
      'failed12@example.test',
      'unknown12@example.test',
      'legacy12@example.test'
    ]
  }];

  await persistProjectEmailPreviews(store.db, 8, previews, 130);

  assert.deepEqual(store.recipients.map(({ email, status, attemptId }) => ({ email, status, attemptId })), [
    { email: 'PARENT12@example.test', status: 'accepted', attemptId: 21 },
    { email: 'failed12@example.test', status: 'failed', attemptId: 22 },
    { email: 'unknown12@example.test', status: 'unresolved', attemptId: 23 },
    { email: 'legacy12@example.test', status: 'unresolved', attemptId: 24 }
  ]);
  assert.deepEqual(store.attempts, originalAttempts, 'historical attempt records remain unchanged');
});

test('Send All processes every queued student email to that student’s guardian group only', async () => {
  const rows = [
    { id: 1, student_id: 12, recipient_email: 'parent12@example.test', status: 'queued',
      subject: 'Photos for student 12', body: 'Student 12 gallery', gallery_link: '/p/student-12' },
    { id: 2, student_id: 12, recipient_email: 'guardian12@example.test', status: 'queued',
      subject: 'Photos for student 12', body: 'Student 12 gallery', gallery_link: '/p/student-12' },
    { id: 3, student_id: 13, recipient_email: 'parent13@example.test', status: 'queued',
      subject: 'Photos for student 13', body: 'Student 13 gallery', gallery_link: '/p/student-13' }
  ];
  const queue = harness(rows);
  const result = await deliverQueueRecipients(queue.recipients, queue);

  assert.equal(result.attempted, 3);
  assert.equal(result.acceptedByGateway, 3);
  assert.deepEqual(queue.sent.map((message) => message.to), [
    'parent12@example.test',
    'guardian12@example.test',
    'parent13@example.test'
  ]);
  assert.ok(queue.sent.slice(0, 2).every((message) => message.link === '/p/student-12'));
  assert.equal(queue.sent[2].link, '/p/student-13');
  assert.equal(queue.sent[0].body.includes('/p/student-13'), false);
});

test('Send All and ordinary retry never retry unresolved or accepted addresses', async () => {
  const rows = [
    { id: 1, student_id: 12, recipient_email: 'parent12@example.test', status: 'queued',
      subject: 'Student 12', body: 'Gallery 12', gallery_link: '/p/12' },
    { id: 2, student_id: 12, recipient_email: 'guardian12@example.test', status: 'queued',
      subject: 'Student 12', body: 'Gallery 12', gallery_link: '/p/12' },
    { id: 3, student_id: 13, recipient_email: 'parent13@example.test', status: 'queued',
      subject: 'Student 13', body: 'Gallery 13', gallery_link: '/p/13' }
  ];
  const queue = harness(rows, new Map([[2, 'rejected'], [3, 'unknown']]));
  const first = await deliverQueueRecipients(queue.recipients, queue);
  assert.equal(first.acceptedByGateway, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.unresolved, 1);

  const repeated = await deliverQueueRecipients(queue.recipients, queue);
  assert.equal(repeated.attempted, 0);
  assert.equal(queue.sent.length, 3);

  queue.failures.clear();
  const retried = await deliverQueueRecipients(queue.recipients, { ...queue, retry: true });
  assert.equal(retried.attempted, 1);
  assert.equal(retried.acceptedByGateway, 1);
  assert.deepEqual(queue.recipients.map((recipient) => recipient.status), ['accepted', 'accepted', 'unresolved']);

  await assert.rejects(
    deliverQueueRecipients(queue.recipients, { ...queue, retryUnresolved: true }),
    /explicit confirmation/
  );
  const unresolvedRetry = await deliverQueueRecipients(queue.recipients, {
    ...queue,
    retryUnresolved: true,
    confirmUnresolved: true
  });
  assert.equal(unresolvedRetry.attempted, 1);
  assert.equal(unresolvedRetry.acceptedByGateway, 1);
  assert.deepEqual(queue.sent.map((message) => message.to), [
    'parent12@example.test',
    'guardian12@example.test',
    'parent13@example.test',
    'guardian12@example.test',
    'parent13@example.test'
  ]);
  assert.deepEqual(queue.recipients.map((recipient) => recipient.status), ['accepted', 'accepted', 'accepted']);
});

test('concurrent Send All requests cannot claim the same queued recipient', async () => {
  const queue = harness([
    { id: 1, student_id: 12, recipient_email: 'parent12@example.test', status: 'queued',
      subject: 'Student 12', body: 'Gallery 12', gallery_link: '/p/12' }
  ]);
  const [first, repeated] = await Promise.all([
    deliverQueueRecipients(queue.recipients, queue),
    deliverQueueRecipients(queue.recipients, queue)
  ]);

  assert.equal(first.attempted + repeated.attempted, 1);
  assert.equal(queue.sent.length, 1);
});
