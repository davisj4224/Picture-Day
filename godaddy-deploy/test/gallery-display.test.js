'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { LEGACY_GALLERY_NAME } = require('../lib/gallery');

const root = path.join(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(root, 'views', 'admin.html'), 'utf8');
const galleryHtml = fs.readFileSync(path.join(root, 'views', 'gallery.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(root, 'public', 'admin.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('legacy galleries have a named selectable collection in the admin', () => {
  assert.equal(LEGACY_GALLERY_NAME, 'Original Picture Day (Existing Photos)');
  assert.match(adminHtml, /id="activeProject"/);
  assert.match(adminHtml, /id="galleryProject"/);
  assert.match(adminHtml, /id="reviewProjectName"/);
  assert.match(adminJs, /<option value="legacy">\$\{LEGACY_GALLERY_NAME\}<\/option>/);
  assert.match(adminJs, /data-select-project="legacy"/);
  assert.match(adminJs, /student\.photoCount\) > 0/);
  assert.match(adminJs, /const collectionName = project\?\.name/);
  assert.match(adminJs, /#reviewProjectName'\)\.textContent = collectionName/);
  assert.match(adminJs, /#galleryProjectName'\)\.textContent = LEGACY_GALLERY_NAME/);
});

test('admin and parent galleries display the selected collection separately from the student name', () => {
  assert.match(adminHtml, /id="galleryProjectName" class="gallery-project-title"/);
  assert.match(adminJs, /#galleryProjectName'\)\.textContent = project\.name/);
  assert.match(galleryHtml, /id="projectContext"/);
  assert.match(galleryHtml, /<strong id="projectName"><\/strong>\s*<\/div>\s*<h1 id="who">/);
  assert.match(galleryHtml, /data\.project\?\.name \|\| 'Original Picture Day \(Existing Photos\)'/);
  assert.match(galleryHtml, /projectName'\)\.textContent = projectName/);
  assert.match(serverJs, /project: \{ id: null, name: LEGACY_GALLERY_NAME, legacy: true \}/);
});
