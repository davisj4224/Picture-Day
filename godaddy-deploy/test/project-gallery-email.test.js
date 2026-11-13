'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  loadProjectGalleryEmailContext,
  loadProjectGalleryEmailHistory
} = require('../lib/project-gallery-email');

const token = 'P'.repeat(32);

function createDb({ projects, memberships, attempts = [] }) {
  let historyQueryCount = 0;
  return {
    get historyQueryCount() {
      return historyQueryCount;
    },
    prepare(sql) {
      return {
        async get(...values) {
          if (sql.includes('FROM projects WHERE id = ?')) {
            return projects.get(Number(values[0])) || null;
          }
          if (sql.includes('FROM project_students ps')) {
            const [projectId, studentId] = values.map(Number);
            return memberships.find((row) =>
              row.project_id === projectId && row.student_id === studentId
            ) || null;
          }
          assert.fail(`Unexpected get query: ${sql}`);
        },
        async all(...values) {
          historyQueryCount++;
          assert.match(sql, /WHERE project_id = \? AND student_id = \? AND email_type = 'project-gallery'/);
          assert.doesNotMatch(sql, /gallery_token|qr_code/i);
          const [projectId, studentId] = values.map(Number);
          return attempts.filter((attempt) =>
            attempt.project_id === projectId &&
            attempt.student_id === studentId &&
            attempt.email_type === 'project-gallery'
          );
        }
      };
    }
  };
}

function project(id) {
  return { id, name: `Project ${id}`, archived_at: null };
}

function membership(projectId, studentId, overrides = {}) {
  return {
    project_id: projectId,
    student_id: studentId,
    gallery_token: token,
    expires_at: Date.now() + 60_000,
    published_at: Date.now(),
    republish_required: 0,
    parent_email: 'current@example.test',
    active: 1,
    ...overrides
  };
}

test('project gallery history is scoped to project and student without returning its token', async () => {
  const db = createDb({
    projects: new Map([[8, project(8)], [9, project(9)]]),
    memberships: [membership(8, 12), membership(9, 12, { gallery_token: 'Q'.repeat(32) })],
    attempts: [
      {
        id: 1,
        project_id: 8,
        student_id: 12,
        email_type: 'project-gallery',
        recipient_email: 'one@example.test',
        error_message: `Gateway echoed ${token}`,
        diagnostic_json: JSON.stringify({ message: `Gateway echoed ${token}` })
      },
      { id: 2, project_id: 9, student_id: 12, email_type: 'project-gallery', recipient_email: 'other-project@example.test' },
      { id: 3, project_id: 8, student_id: 12, email_type: 'gallery', recipient_email: 'original@example.test' }
    ]
  });

  const history = await loadProjectGalleryEmailHistory(db, 8, 12);
  assert.equal(history.eligible, true);
  assert.equal(history.recipientEmail, 'current@example.test');
  assert.deepEqual(history.attempts.map((attempt) => attempt.id), [1]);
  assert.equal(JSON.stringify(history).includes(token), false);
  assert.equal(Object.hasOwn(history, 'gallery_token'), false);
});

test('a project and student mismatch cannot resolve another project gallery or its history', async () => {
  const db = createDb({
    projects: new Map([[8, project(8)], [9, project(9)]]),
    memberships: [membership(9, 12)]
  });

  assert.equal(await loadProjectGalleryEmailContext(db, 8, 12), null);
  assert.equal(await loadProjectGalleryEmailHistory(db, 8, 12), null);
  assert.equal(db.historyQueryCount, 0);
});

test('project history and resend routes require staff, and Original Picture Day resend remains separate', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /'\/api\/projects\/:projectId\/students\/:studentId\/email-history',\s*requireStaff/);
  assert.match(server, /'\/api\/projects\/:projectId\/students\/:studentId\/resend-gallery-email',\s*requireStaff/);

  const legacyStart = server.indexOf("'/api/students/:id/resend-gallery-email'");
  const projectHistoryStart = server.indexOf("'/api/projects/:projectId/students/:studentId/email-history'");
  assert.ok(legacyStart >= 0 && projectHistoryStart > legacyStart);
  const legacyResend = server.slice(legacyStart, projectHistoryStart);
  assert.match(legacyResend, /sendGalleryEmail\(student\.id\)/);
  assert.doesNotMatch(legacyResend, /project-gallery|projectId/);
  const legacySendStart = server.indexOf('async function sendGalleryEmail');
  const legacySend = server.slice(legacySendStart, legacyStart);
  assert.match(legacySend, /email_type = 'gallery'/);
  assert.doesNotMatch(legacySend, /project-gallery|projectId/);
});
