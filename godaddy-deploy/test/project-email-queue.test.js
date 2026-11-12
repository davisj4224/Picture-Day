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

test('persisting previews creates one saved, student-specific queue item without a delivery dependency', async () => {
  const items = new Map();
  const recipients = [];
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
              } else {
                const [queueItemId, email] = values;
                const existing = recipients.find((recipient) =>
                  recipient.queueItemId === queueItemId && recipient.email === email
                );
                if (!existing) recipients.push({ queueItemId, email, status: 'queued' });
                else if (existing.status === 'excluded') existing.status = 'queued';
              }
            },
            async get(projectId, studentId) {
              return items.get(`${projectId}:${studentId}`);
            }
          };
        }
      });
    }
  };
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

test('repeated Send All claims no successful address twice and retry targets only failures', async () => {
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
  assert.equal(retried.attempted, 2);
  assert.equal(retried.acceptedByGateway, 2);
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
