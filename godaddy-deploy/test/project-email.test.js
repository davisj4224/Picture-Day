'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { requireAdmin } = require('../lib/admin-auth');
const { galleryLink } = require('../lib/gallery');
const {
  buildProjectExportCsv,
  buildProjectEmailPreviews,
  loadProjectEmailContext,
  parseProjectEmailAddresses,
  renderProjectEmail,
  resolveProjectEmailRecipients
} = require('../lib/project-email');

const publicUrl = 'https://photos.example.test';
const projectToken = 'P'.repeat(32);
const otherProjectToken = 'Q'.repeat(32);
const legacyToken = 'L'.repeat(32);

function student(id, projectId, token, overrides = {}) {
  return {
    student_id: id,
    project_id: projectId,
    gallery_token: token,
    expires_at: Date.now() + 60_000,
    published_at: Date.now(),
    active: 1,
    first_name: `First${id}`,
    last_name: `Last${id}`,
    parent_email: `parent${id}@example.test`,
    ...overrides
  };
}

test('project email content always names the project and uses the exact project gallery token', () => {
  const project = { id: 8, name: 'Winter Pictures' };
  const recipient = student(12, 8, projectToken);
  const rendered = renderProjectEmail(
    project,
    recipient,
    { emailSubject: 'Photos for {{student}}', emailBody: 'Hello {{first}}.' },
    { schoolName: 'North School', year: '2026' },
    publicUrl
  );

  assert.equal(rendered.link, `${publicUrl}/p/${projectToken}`);
  assert.match(rendered.subject, /Winter Pictures/);
  assert.match(rendered.text, /Winter Pictures/);
  assert.ok(rendered.text.includes(rendered.link));
  assert.equal(rendered.text.includes(otherProjectToken), false);
  assert.equal(rendered.text.includes(legacyToken), false);
});

test('project-scoped database resolution cannot return another project student or token', async () => {
  const projects = new Map([
    [8, { id: 8, name: 'Winter Pictures', archived_at: null }],
    [9, { id: 9, name: 'Spring Pictures', archived_at: null }]
  ]);
  const memberships = [
    student(12, 8, projectToken),
    student(12, 9, otherProjectToken)
  ];
  const db = {
    prepare(sql) {
      return {
        async get(id) {
          assert.match(sql, /FROM projects WHERE id = \?/);
          return projects.get(Number(id));
        },
        async all(id) {
          assert.match(sql, /WHERE ps\.project_id = \?/);
          return memberships.filter((row) => row.project_id === Number(id));
        }
      };
    }
  };

  const context = await loadProjectEmailContext(db, 8, publicUrl, Date.now(), [12]);
  assert.equal(context.recipients.length, 1);
  assert.equal(context.recipients[0].link, `${publicUrl}/p/${projectToken}`);
  const otherStudent = await loadProjectEmailContext(db, 8, publicUrl, Date.now(), [999]);
  assert.deepEqual(otherStudent.invalidIds, [999]);
  assert.equal(otherStudent.recipients.length, 0);
});

test('multiple selected students preview separate messages and only their own guardian addresses', () => {
  const project = { id: 8, name: 'Winter Pictures' };
  const rows = [
    student(12, 8, projectToken, { parent_email: 'parent12@example.test; guardian12@example.test' }),
    student(13, 8, otherProjectToken, { parent_email: 'parent13@example.test, guardian13@example.test' })
  ];
  const context = resolveProjectEmailRecipients(project, rows, publicUrl, Date.now(), [12, 13]);
  const previews = buildProjectEmailPreviews(
    project,
    context.recipients,
    { emailSubject: 'Photos for {{student}}', emailBody: 'Hello {{first}}. {{link}}' },
    { schoolName: 'North School', year: '2026' },
    publicUrl
  );

  assert.equal(previews.length, 2);
  assert.deepEqual(previews[0].recipientEmails, ['parent12@example.test', 'guardian12@example.test']);
  assert.deepEqual(previews[1].recipientEmails, ['parent13@example.test', 'guardian13@example.test']);
  assert.match(previews[0].text, /First12 Last12/);
  assert.match(previews[0].text, new RegExp(projectToken));
  assert.doesNotMatch(previews[0].text, new RegExp(otherProjectToken));
  assert.match(previews[1].text, /First13 Last13/);
  assert.match(previews[1].text, new RegExp(otherProjectToken));
  assert.equal(previews[0].recipientEmails.includes('parent13@example.test'), false);
  assert.equal(previews[1].recipientEmails.includes('parent12@example.test'), false);
});

test('unpublished, expired, malformed-token, and archived galleries are unavailable to email', () => {
  const rows = [
    student(1, 8, 'A'.repeat(32), { published_at: null }),
    student(2, 8, 'B'.repeat(32), { expires_at: Date.now() - 1 }),
    student(3, 8, 'invalid-token'),
    student(4, 8, projectToken),
    student(5, 8, otherProjectToken, { republish_required: 1 })
  ];
  const active = resolveProjectEmailRecipients(
    { id: 8, name: 'Winter Pictures', archived_at: null },
    rows,
    publicUrl,
    Date.now(),
    [1, 2, 3, 5]
  );
  assert.deepEqual(active.recipients, []);
  assert.deepEqual(active.invalidIds, [1, 2, 3, 5]);

  const archived = resolveProjectEmailRecipients(
    { id: 8, name: 'Winter Pictures', archived_at: Date.now() },
    [rows[3]],
    publicUrl,
    Date.now(),
    [4]
  );
  assert.deepEqual(archived.recipients, []);
  assert.deepEqual(archived.invalidIds, [4]);
});

test('inactive galleries and missing or invalid parent email addresses are excluded with reasons', () => {
  const rows = [
    student(1, 8, projectToken, { active: 0 }),
    student(2, 8, otherProjectToken, { parent_email: '' }),
    student(3, 8, legacyToken, { parent_email: 'not-an-email' }),
    student(4, 8, 'R'.repeat(32), { parent_email: 'valid@example.test;invalid-address' })
  ];
  const result = resolveProjectEmailRecipients(
    { id: 8, name: 'Winter Pictures', archived_at: null },
    rows,
    publicUrl
  );

  assert.deepEqual(result.recipients.map((row) => row.student_id), [4]);
  assert.deepEqual(result.recipients[0].recipientEmails, ['valid@example.test']);
  assert.deepEqual(result.recipients[0].invalidEmails, ['invalid-address']);
  assert.deepEqual(result.excluded.map((row) => row.reason), [
    'Student is inactive.',
    'No parent/guardian email address is on file.',
    'No valid parent/guardian email address is on file.'
  ]);
  assert.deepEqual(parseProjectEmailAddresses('one@example.test, ONE@example.test, two@example.test;bad'), {
    valid: ['one@example.test', 'two@example.test'],
    invalid: ['bad']
  });
});

test('project export preserves legacy columns and only emits the selected valid project link', () => {
  const project = { id: 8, name: 'Winter Pictures', archived_at: null };
  const students = [
    { id: 12, first_name: 'First12', last_name: 'Last12', grade: '4', teacher: 'Lee',
      parent_email: 'parent12@example.test', gallery_token: legacyToken, published_at: 1, expires_at: null },
    { id: 13, first_name: 'First13', last_name: 'Last13', grade: '5', teacher: 'Kim',
      parent_email: 'parent13@example.test', gallery_token: null, published_at: null, expires_at: null },
    { id: 14, first_name: 'First14', last_name: 'Last14', grade: '6', teacher: 'Ray',
      parent_email: 'parent14@example.test', gallery_token: null, published_at: null, expires_at: null },
    { id: 15, first_name: 'First15', last_name: 'Last15', grade: '3', teacher: 'Park',
      parent_email: 'parent15@example.test', gallery_token: null, published_at: null, expires_at: null }
  ];
  const memberships = new Map([
    [12, student(12, 8, projectToken)],
    [14, student(14, 8, 'bad-token')],
    [15, student(15, 8, otherProjectToken, { republish_required: 1 })]
  ]);

  const csv = buildProjectExportCsv(students, project, memberships, publicUrl, Date.now());
  const lines = csv.split('\n');
  assert.match(lines[0], /"Gallery link".*"Photo shoot project".*"Project gallery link"/);
  assert.ok(lines[1].includes(`"${galleryLink(legacyToken, publicUrl)}"`));
  assert.ok(lines[1].includes('"Winter Pictures"'));
  assert.ok(lines[1].includes(`"${publicUrl}/p/${projectToken}"`));
  assert.ok(lines[2].includes('""'));
  assert.ok(lines[3].endsWith('""'));
  assert.ok(lines[4].endsWith('""'), 'republish-required memberships must not export a public link');

  const archivedCsv = buildProjectExportCsv(
    students.slice(0, 1),
    { ...project, archived_at: Date.now() },
    memberships,
    publicUrl
  );
  assert.ok(archivedCsv.split('\n')[1].endsWith('""'));
});

test('administrator authorization allows admins and rejects staff for project email preview and send', () => {
  let allowed = false;
  requireAdmin({ session: { user: { role: 'admin' } }, path: '/api/projects/8/email/send' }, {}, () => {
    allowed = true;
  });
  assert.equal(allowed, true);

  for (const action of ['preview', 'send-all', 'queue/1/retry']) {
    let statusCode;
    let responseBody;
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
    requireAdmin({ session: { user: { role: 'staff' } }, path: `/api/projects/8/email/${action}` }, response, () => {
      assert.fail('staff must not be authorized');
    });
    assert.equal(statusCode, 403);
    assert.match(responseBody.error, /Administrator/);
  }
});
