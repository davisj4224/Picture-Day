'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');
const { denyPhotoAssetStaticAccess, resolveAssetRoot } = require('../lib/photo-storage');

const appRoot = path.join(path.sep, 'app', 'godaddy-deploy');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('default photo asset root resolves to app-root persistent storage', () => {
  assert.equal(
    resolveAssetRoot(appRoot),
    path.join(path.sep, 'app', 'public', 'assets', 'pictureday')
  );
});

test('PICTUREDAY_ASSET_DIR overrides the default photo asset root', () => {
  assert.equal(resolveAssetRoot(appRoot, '/mnt/persistent/pictureday'), '/mnt/persistent/pictureday');
});

test('Express returns 404 for direct full-photo and thumbnail asset requests', async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pictureday-static-test-'));
  const publicDirectory = path.join(temporaryRoot, 'public');
  const server = express();

  try {
    for (const directory of ['full', 'thumb']) {
      const fixtureDirectory = path.join(publicDirectory, 'pictureday', directory);
      await fs.promises.mkdir(fixtureDirectory, { recursive: true });
      await fs.promises.writeFile(path.join(fixtureDirectory, 'fixture.jpg'), 'not a real photo');
    }

    server.use(denyPhotoAssetStaticAccess);
    server.use('/assets', express.static(publicDirectory));

    const listener = await new Promise((resolve, reject) => {
      const instance = server.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });

    try {
      const { port } = listener.address();
      for (const directory of ['full', 'thumb']) {
        const response = await fetch(`http://127.0.0.1:${port}/assets/pictureday/${directory}/fixture.jpg`);
        assert.equal(response.status, 404, `${directory} files must not be served as static assets`);
      }
    } finally {
      await new Promise((resolve, reject) => {
        listener.close((error) => error ? reject(error) : resolve());
      });
    }
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('photo file routes keep their staff and gallery authorization guards', () => {
  assert.match(serverSource, /app\.get\('\/api\/photos\/:id\/file', requireStaff/);
  assert.match(serverSource, /app\.get\('\/api\/gallery\/:token\/photo\/:id'/);
  assert.match(
    serverSource,
    /WHERE id = \? AND student_id = \? AND published = 1 AND hidden = 0/
  );
  assert.match(serverSource, /res\.sendFile\(path\.join\(thumb \? UP_THUMB : UP_FULL/);
});
