'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

async function loadSelectionGuard() {
  return import('../public/project-email-selection.mjs');
}

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
