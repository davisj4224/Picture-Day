'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  parseEmailProjectId,
  loadEmailRows,
  emailTemplateVariables
} = require('../lib/email-workflow');

const root = path.join(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(root, 'views', 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'public', 'admin.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('admin initialization does not reference removed role-specific email elements', () => {
  const initialization = adminJs.slice(
    adminJs.indexOf('/* ------------------------------------------------------------- startup */'),
    adminJs.indexOf('/* ------------------------------------------------------------------ nav */')
  );

  assert.doesNotMatch(initialization, /#(?:projectEmailCard|legacyEmailCard|legacyEmailExport)\b/);
});

function fakeEmailDb() {
  const queries = [];
  const project = { id: 23, name: 'Spring Portraits', archived_at: null };
  const legacyStudent = {
    id: 11,
    first_name: 'Legacy',
    last_name: 'Student',
    parent_email: 'legacy-parent@example.test',
    gallery_token: 'l'.repeat(32),
    expires_at: null
  };
  const projectStudent = {
    id: 22,
    first_name: 'Project',
    last_name: 'Student',
    parent_email: 'project-parent@example.test',
    project_gallery_token: 'p'.repeat(32),
    project_expires_at: null,
    project_name: project.name
  };

  return {
    queries,
    legacyStudent,
    projectStudent,
    prepare(sql) {
      return {
        async get(...params) {
          queries.push({ kind: 'get', sql, params });
          return sql.includes('FROM projects') ? project : null;
        },
        async all(...params) {
          queries.push({ kind: 'all', sql, params });
          if (sql.includes('FROM students s')) return [legacyStudent];
          if (sql.includes('FROM project_students ps')) return [projectStudent];
          throw new Error('Unexpected email query');
        }
      };
    }
  };
}

test('Email restores the launch layout with one default Original Picture Day selector', () => {
  const section = adminHtml.slice(adminHtml.indexOf('id="view-email"'), adminHtml.indexOf('id="view-settings"'));

  assert.match(section, /<select id="emailProject"><option value="legacy">Original Picture Day<\/option>/);
  assert.match(section, /id="pendingTable"/);
  assert.match(section, /id="pendAll"/);
  assert.match(section, /id="sendEmails">Send to selected/);
  assert.match(section, /id="emSubject"/);
  assert.match(section, /id="emBody"/);
  assert.match(section, /id="saveEmail"/);
  assert.match(section, /id="sendTest"/);
  assert.doesNotMatch(section, /projectEmail|Preview selected|queue|delivery attempts|SMTP response/);
  assert.match(adminJs, /api\(`\/api\/email\/pending\?projectId=\$\{encodeURIComponent\(projectId\)\}`\)/);
  assert.match(adminJs, /body: \{ ids, projectId \}/);
  assert.doesNotMatch(adminJs, /\/api\/projects\/\$\{projectId\}\/email\/(recipients|preview|send)/);
});

test('Original Picture Day selection returns only legacy galleries and uses legacy gallery links', async () => {
  assert.equal(parseEmailProjectId(undefined), null);
  assert.equal(parseEmailProjectId('legacy'), null);
  const db = fakeEmailDb();
  const rows = await loadEmailRows(db, parseEmailProjectId('legacy'));
  const query = db.queries.find((entry) => entry.kind === 'all');

  assert.deepEqual(rows, [db.legacyStudent]);
  assert.match(query.sql, /ph\.project_id IS NULL/);
  assert.match(query.sql, /email_log e/);
  assert.deepEqual(query.params, []);

  const variables = emailTemplateVariables(
    db.legacyStudent,
    null,
    { schoolName: 'Test School', eventName: 'Picture Day', year: '2026' },
    'https://photos.example.test/'
  );
  assert.equal(variables.link, `https://photos.example.test/g/${'l'.repeat(32)}`);
  assert.equal(variables.event, 'Picture Day');
});

test('selecting a newer project returns its own galleries, recipients, and project links', async () => {
  const db = fakeEmailDb();
  const now = 1763000000000;
  const rows = await loadEmailRows(db, 23, { now });
  const query = db.queries.find((entry) => entry.kind === 'all');

  assert.deepEqual(rows, [db.projectStudent]);
  assert.match(query.sql, /FROM project_students ps/);
  assert.match(query.sql, /ph\.project_id = ps\.project_id/);
  assert.match(query.sql, /gallery_email_attempts a/);
  assert.deepEqual(query.params, [23, now]);
  assert.equal(parseEmailProjectId('23'), 23);
  assert.equal(parseEmailProjectId('0'), undefined);

  const variables = emailTemplateVariables(
    db.projectStudent,
    23,
    { schoolName: 'Test School', eventName: 'Picture Day', year: '2026' },
    'https://photos.example.test'
  );
  assert.equal(variables.link, `https://photos.example.test/p/${'p'.repeat(32)}`);
  assert.equal(variables.event, 'Spring Portraits');
});

test('pending API and send API retain the original endpoints while carrying selected project context', () => {
  assert.match(serverJs, /app\.get\('\/api\/email\/pending'/);
  assert.match(serverJs, /app\.post\([\s\S]*?'\/api\/email\/send'/);
  assert.match(serverJs, /parseEmailProjectId\(req\.query\.projectId\)/);
  assert.match(serverJs, /parseEmailProjectId\(req\.body\?\.projectId\)/);
  assert.match(serverJs, /emailTemplateVariables\(student, projectId/);
  assert.match(serverJs, /to: recipient\.recipient_email,\s*from: cfg\.emailFrom,/);
});
