'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sendProjectEmailRecipients } = require('../lib/project-email-send');
const { SENDING_LEASE_MS } = require('../lib/project-email-queue');

const TOKEN_ONE = 'P'.repeat(32);
const TOKEN_TWO = 'Q'.repeat(32);

function createDb({ projects, memberships, attempts = [] }) {
  let nextAttemptId = Math.max(0, ...attempts.map((attempt) => attempt.id)) + 1;
  let transactionTail = Promise.resolve();

  function prepare(sql) {
    return {
      async get(...values) {
        if (sql.includes('FROM projects WHERE id = ?')) {
          return projects.get(Number(values[0])) || null;
        }
        if (sql.includes('FROM project_students ps')) {
          const [projectId, studentId] = values.map(Number);
          const membership = memberships.find((row) =>
            row.project_id === projectId && row.student_id === studentId
          );
          return membership ? { ...membership } : null;
        }
        assert.fail(`Unexpected get query: ${sql}`);
      },
      async all(...values) {
        if (sql.includes('FROM project_students ps')) {
          return memberships.filter((row) => row.project_id === Number(values[0])).map((row) => ({ ...row }));
        }
        if (sql.includes('FROM gallery_email_attempts')) {
          const [projectId, studentId, recipientEmail] = values;
          return attempts
            .filter((attempt) =>
              attempt.project_id === Number(projectId) &&
              attempt.student_id === Number(studentId) &&
              attempt.email_type === 'project-gallery' &&
              attempt.recipient_email.toLowerCase() === recipientEmail.toLowerCase()
            )
            .sort((left, right) => right.attempted_at - left.attempted_at || right.id - left.id)
            .map((attempt) => ({ ...attempt }));
        }
        assert.fail(`Unexpected all query: ${sql}`);
      },
      async run(...values) {
        if (sql.includes('INSERT INTO gallery_email_attempts')) {
          const [studentId, projectId, recipientEmail, attemptedAt] = values;
          const attempt = {
            id: nextAttemptId++,
            student_id: studentId,
            project_id: projectId,
            recipient_email: recipientEmail,
            email_type: 'project-gallery',
            attempted_at: attemptedAt,
            status: 'pending',
            outcome: null
          };
          attempts.push(attempt);
          return { lastInsertRowid: attempt.id, changes: 1 };
        }
        if (sql.includes('UPDATE gallery_email_attempts')) {
          const [status, errorMessage, outcome, diagnostics, messageId, id] = values;
          const attempt = attempts.find((row) => row.id === id && row.email_type === 'project-gallery');
          if (!attempt) return { changes: 0 };
          Object.assign(attempt, {
            status,
            error_message: errorMessage,
            outcome,
            diagnostic_json: diagnostics,
            message_id: messageId
          });
          return { changes: 1 };
        }
        assert.fail(`Unexpected run query: ${sql}`);
      }
    };
  }

  return {
    attempts,
    prepare,
    async transaction(callback) {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback({ prepare });
      } finally {
        release();
      }
    }
  };
}

function student(projectId, id, token, overrides = {}) {
  return {
    project_id: projectId,
    student_id: id,
    gallery_token: token,
    expires_at: Date.now() + 60_000,
    published_at: Date.now(),
    republish_required: 0,
    first_name: `First${id}`,
    last_name: `Last${id}`,
    parent_email: `parent${id}@example.test`,
    active: 1,
    ...overrides
  };
}

function sendOptions(db, send, projectId = 8, studentIds = [12]) {
  return {
    db,
    projectId,
    studentIds,
    publicUrl: 'https://photos.example.test',
    emailConfig: {
      emailSubject: 'Photos for {{student}}',
      emailBody: 'Hello {{first}}. {{link}}',
      emailReplyTo: 'office@example.test'
    },
    branding: { schoolName: 'North School', year: '2026', palette: { primary: '#123456' } },
    mailer: { send },
    now: () => Date.now()
  };
}

test('project send isolates memberships and records each parent address with the project gallery link', async () => {
  const db = createDb({
    projects: new Map([
      [8, { id: 8, name: 'Winter Pictures', archived_at: null }],
      [9, { id: 9, name: 'Spring Pictures', archived_at: null }]
    ]),
    memberships: [
      student(8, 12, TOKEN_ONE, { parent_email: 'parent@example.test; guardian@example.test' }),
      student(9, 12, TOKEN_TWO, { parent_email: 'other-project@example.test' })
    ]
  });
  const sent = [];
  const result = await sendProjectEmailRecipients(sendOptions(db, async (message) => {
    sent.push(message);
    return { outcome: 'accepted', messageId: `message-${sent.length}`, diagnostics: { outcome: 'accepted' } };
  }));

  assert.equal(result.acceptedByGateway, 2);
  assert.deepEqual(sent.map((message) => message.to), ['parent@example.test', 'guardian@example.test']);
  assert.ok(sent.every((message) => message.link === `https://photos.example.test/p/${TOKEN_ONE}`));
  assert.ok(sent.every((message) => message.text.includes(`https://photos.example.test/p/${TOKEN_ONE}`)));
  assert.ok(sent.every((message) => message.subject.includes('Winter Pictures')));
  assert.equal(db.attempts.length, 2);
  assert.ok(db.attempts.every((attempt) =>
    attempt.project_id === 8 &&
    attempt.email_type === 'project-gallery' &&
    attempt.status === 'accepted' &&
    attempt.outcome === 'accepted'
  ));
});

test('historical attempts can be deliberately resent without rewriting history', async () => {
  const attemptedAt = Date.now() - SENDING_LEASE_MS - 1;
  const history = [
    { id: 1, project_id: 8, student_id: 12, recipient_email: 'accepted@example.test',
      email_type: 'project-gallery', attempted_at: attemptedAt, status: 'accepted', outcome: 'accepted' },
    { id: 2, project_id: 8, student_id: 12, recipient_email: 'pending@example.test',
      email_type: 'project-gallery', attempted_at: attemptedAt, status: 'pending', outcome: null },
    { id: 3, project_id: 8, student_id: 12, recipient_email: 'unknown@example.test',
      email_type: 'project-gallery', attempted_at: attemptedAt, status: 'unresolved', outcome: 'unknown' },
    { id: 4, project_id: 8, student_id: 12, recipient_email: 'rejected@example.test',
      email_type: 'project-gallery', attempted_at: attemptedAt, status: 'failed', outcome: 'rejected' }
  ];
  const db = createDb({
    projects: new Map([[8, { id: 8, name: 'Winter Pictures', archived_at: null }]]),
    memberships: [student(8, 12, TOKEN_ONE, {
      parent_email: 'accepted@example.test; pending@example.test; unknown@example.test; rejected@example.test'
    })],
    attempts: history
  });
  const sent = [];
  const result = await sendProjectEmailRecipients(sendOptions(db, async (message) => {
    sent.push(message.to);
    return { outcome: 'accepted', messageId: `message-${sent.length}`, diagnostics: { outcome: 'accepted' } };
  }));

  assert.deepEqual(sent, [
    'accepted@example.test',
    'pending@example.test',
    'unknown@example.test',
    'rejected@example.test'
  ]);
  assert.equal(result.attempted, 4);
  assert.equal(result.skipped, 0);
  assert.equal(result.acceptedByGateway, 4);
  assert.equal(history[2].outcome, 'unknown', 'unresolved historical evidence is not rewritten');
  assert.equal(history[3].outcome, 'rejected', 'the rejected historical attempt remains intact');
  assert.equal(db.attempts.length, 8);
  assert.ok(db.attempts.slice(4).every((attempt) => attempt.status === 'accepted'));
});

test('failed and unresolved attempts can both be deliberately retried', async () => {
  const db = createDb({
    projects: new Map([[8, { id: 8, name: 'Winter Pictures', archived_at: null }]]),
    memberships: [student(8, 12, TOKEN_ONE, {
      parent_email: 'rejected@example.test; uncertain@example.test'
    })]
  });
  const result = await sendProjectEmailRecipients(sendOptions(db, async (message) => {
    const error = new Error(`gateway ${message.to}`);
    error.diagnostics = { outcome: message.to.startsWith('rejected') ? 'rejected' : 'unknown' };
    throw error;
  }));

  assert.equal(result.failed, 1);
  assert.equal(result.unresolved, 1);
  assert.deepEqual(db.attempts.map(({ status, outcome }) => ({ status, outcome })), [
    { status: 'failed', outcome: 'rejected' },
    { status: 'unresolved', outcome: 'unknown' }
  ]);
  const retryResult = await sendProjectEmailRecipients(sendOptions(db, async (message) => {
    assert.ok(['rejected@example.test', 'uncertain@example.test'].includes(message.to));
    return { outcome: 'accepted', messageId: 'retry-accepted', diagnostics: { outcome: 'accepted' } };
  }));
  assert.equal(retryResult.attempted, 2);
  assert.equal(retryResult.skipped, 0);
  assert.equal(db.attempts[1].outcome, 'unknown');
  assert.deepEqual(db.attempts.slice(2).map((attempt) => attempt.status), ['accepted', 'accepted']);
});

test('a recent pending claim blocks a simultaneous resend but an expired pending claim does not', async () => {
  const createDbWithPending = (attemptedAt) => createDb({
    projects: new Map([[8, { id: 8, name: 'Winter Pictures', archived_at: null }]]),
    memberships: [student(8, 12, TOKEN_ONE)],
    attempts: [{
      id: 1,
      project_id: 8,
      student_id: 12,
      recipient_email: 'parent12@example.test',
      email_type: 'project-gallery',
      attempted_at: attemptedAt,
      status: 'pending',
      outcome: null
    }]
  });
  const activeDb = createDbWithPending(Date.now());
  const activeResult = await sendProjectEmailRecipients(sendOptions(activeDb, async () => {
    assert.fail('a recent pending attempt must prevent duplicate delivery');
  }));
  assert.equal(activeResult.skipped, 1);
  assert.equal(activeDb.attempts.length, 1);

  const staleDb = createDbWithPending(Date.now() - SENDING_LEASE_MS - 1);
  const staleResult = await sendProjectEmailRecipients(sendOptions(staleDb, async () => ({
    outcome: 'accepted',
    messageId: 'stale-retry',
    diagnostics: { outcome: 'accepted' }
  })));
  assert.equal(staleResult.acceptedByGateway, 1);
  assert.equal(staleDb.attempts.length, 2);
  assert.equal(staleDb.attempts[0].status, 'pending', 'the stale historical attempt is retained');
});

test('archived projects and unpublished galleries are never sent', async () => {
  const archivedDb = createDb({
    projects: new Map([[8, { id: 8, name: 'Archived Pictures', archived_at: 10 }]]),
    memberships: [student(8, 12, TOKEN_ONE)]
  });
  const archived = await sendProjectEmailRecipients(sendOptions(archivedDb, async () => {
    assert.fail('archived project must not send');
  }));
  assert.equal(archived.status, 'archived');
  assert.equal(archivedDb.attempts.length, 0);

  const unpublishedDb = createDb({
    projects: new Map([[8, { id: 8, name: 'Winter Pictures', archived_at: null }]]),
    memberships: [student(8, 12, TOKEN_ONE, { published_at: null })]
  });
  const unpublished = await sendProjectEmailRecipients(sendOptions(unpublishedDb, async () => {
    assert.fail('unpublished gallery must not send');
  }));
  assert.equal(unpublished.attempted, 0);
  assert.equal(unpublished.excluded, 1);
  assert.equal(unpublishedDb.attempts.length, 0);
});

test('concurrent sends claim a project recipient only once', async () => {
  const db = createDb({
    projects: new Map([[8, { id: 8, name: 'Winter Pictures', archived_at: null }]]),
    memberships: [student(8, 12, TOKEN_ONE)]
  });
  let sends = 0;
  const send = async () => {
    sends++;
    await new Promise((resolve) => setImmediate(resolve));
    return { outcome: 'accepted', messageId: 'one-message', diagnostics: { outcome: 'accepted' } };
  };

  const [first, second] = await Promise.all([
    sendProjectEmailRecipients(sendOptions(db, send)),
    sendProjectEmailRecipients(sendOptions(db, send))
  ]);
  assert.equal(first.attempted + second.attempted, 1);
  assert.equal(sends, 1);
  assert.equal(db.attempts.length, 1);
});
