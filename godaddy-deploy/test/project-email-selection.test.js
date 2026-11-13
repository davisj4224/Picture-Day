'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

async function loadSelectionGuard() {
  return import('../public/project-email-selection.mjs');
}

test('Email keeps a simple project select, recipient, preview, and send workflow', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  const section = html.slice(html.indexOf('id="view-email"'), html.indexOf('id="view-settings"'));

  assert.match(section, /id="projectEmailProject"/);
  assert.match(section, /id="projectEmailRecipients"/);
  assert.match(section, /id="previewProjectEmails"/);
  assert.match(section, /id="sendProjectEmails"/);
  assert.match(adminJs, /projectEmailPreview\.previews\[0\]/);
  assert.doesNotMatch(adminJs, /projectEmailPreview\.previews\.map/);
  assert.doesNotMatch(section, /projectEmailQueue|queue-management|PARENT_EMAIL_PUBLISHED_HOST/);
  assert.doesNotMatch(section, /Recent delivery attempts|SMTP response \/ details|Excluded galleries/);
});

test('a late project response cannot update the newly selected project', async () => {
  const { createProjectEmailSelectionGuard } = await loadSelectionGuard();
  const guard = createProjectEmailSelectionGuard();
  const previousProject = guard.begin(8);
  const currentProject = guard.begin(9);

  assert.equal(guard.isCurrent(previousProject, 9), false);
  assert.equal(guard.isCurrent(currentProject, 9), true);
  assert.equal(guard.isCurrent(currentProject, 8), false);
});

test('clearing the project selection invalidates responses already in flight', async () => {
  const { createProjectEmailSelectionGuard } = await loadSelectionGuard();
  const guard = createProjectEmailSelectionGuard();
  const pendingRequest = guard.begin(8);
  guard.begin('');

  assert.equal(guard.isCurrent(pendingRequest, ''), false);
});

test('email project options include the original archived project and every newer project', async () => {
  const { projectEmailOptions } = await loadSelectionGuard();
  const projects = projectEmailOptions([
    { id: 1, name: 'Original Picture Day Project', archived_at: 1 },
    { id: 2, name: 'Fall Pictures', archived_at: null },
    { id: 3, name: 'Spring Pictures', archived_at: null }
  ]);

  assert.deepEqual(projects.map(({ id }) => id), [1, 2, 3]);
  assert.equal(projects[0].displayName, 'Original Picture Day Project (Archived)');
  assert.equal(projects[1].displayName, 'Fall Pictures');
});
