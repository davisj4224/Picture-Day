'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');
const { requireAdmin } = require('../lib/admin-auth');
const {
  denyPhotoAssetStaticAccess,
  auditPhotoFiles,
  inspectFilesystemMetadata,
  resolveAssetRoot
} = require('../lib/photo-storage');

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

test('filesystem metadata reports the resolved root, nearest mount, and device IDs without source details', async () => {
  const statResults = {
    '/private': { isDirectory: () => true, dev: 12 },
    '/private/pictureday': { isDirectory: () => true, dev: 12 },
    '/app': { isDirectory: () => true, dev: 34 }
  };
  const mountInfo = [
    '1 0 8:1 / / rw - ext4 /dev/root rw',
    '2 1 8:2 / /private rw - xfs /dev/private rw',
    '3 2 8:3 / /private/pictureday rw - tmpfs secret-source rw'
  ].join('\n');
  const result = await inspectFilesystemMetadata('/private/pictureday', {
    stat: async (targetPath) => statResults[targetPath],
    readFile: async () => mountInfo
  });

  assert.deepEqual(result, {
    assetRoot: '/private/pictureday',
    directories: {
      private: { exists: true, isDirectory: true, error: null },
      privatePictureday: { exists: true, isDirectory: true, error: null }
    },
    mount: {
      private: {
        available: true,
        mountPoint: '/private',
        filesystemType: 'xfs',
        device: '8:2'
      }
    },
    devices: {
      private: { available: true, device: '12', reason: null },
      app: { available: true, device: '34', reason: null }
    }
  });
  assert.equal(JSON.stringify(result).includes('/dev/private'), false);
  assert.equal(JSON.stringify(result).includes('secret-source'), false);
});

test('filesystem metadata reports missing paths and unreadable mount information safely', async () => {
  const missingPath = Object.assign(new Error('private path missing'), { code: 'ENOENT' });
  const denied = Object.assign(new Error('sensitive details'), { code: 'EACCES' });
  const result = await inspectFilesystemMetadata('/configured/assets', {
    stat: async (targetPath) => {
      if (targetPath === '/app') return { isDirectory: () => true, dev: 34 };
      throw missingPath;
    },
    readFile: async () => {
      throw denied;
    }
  });

  assert.deepEqual(result, {
    assetRoot: '/configured/assets',
    directories: {
      private: { exists: false, isDirectory: false, error: 'not_found' },
      privatePictureday: { exists: false, isDirectory: false, error: 'not_found' }
    },
    mount: { private: { available: false, reason: 'permission_denied' } },
    devices: {
      private: { available: false, device: null, reason: 'not_found' },
      app: { available: true, device: '34', reason: null }
    }
  });
  assert.equal(JSON.stringify(result).includes('sensitive details'), false);
});

test('photo file audit returns only aggregate presence counts for stored file and thumbnail names', async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pictureday-photo-audit-test-'));
  const assetRoot = path.join(temporaryRoot, 'assets');
  const fullDirectory = path.join(assetRoot, 'full');
  const thumbDirectory = path.join(assetRoot, 'thumb');
  await fs.promises.mkdir(fullDirectory, { recursive: true });
  await fs.promises.mkdir(thumbDirectory, { recursive: true });
  await fs.promises.writeFile(path.join(fullDirectory, 'present-full.jpg'), 'full');
  await fs.promises.writeFile(path.join(fullDirectory, 'no-thumbnail.jpg'), 'full');
  await fs.promises.writeFile(path.join(thumbDirectory, 'present-thumb.jpg'), 'thumb');
  const photos = [
    { file: 'present-full.jpg', thumb: 'present-thumb.jpg' },
    { file: 'missing-full.jpg', thumb: 'missing-thumb.jpg' },
    { file: 'no-thumbnail.jpg', thumb: null }
  ];
  const db = {
    prepare(sql) {
      assert.equal(sql, 'SELECT file, thumb FROM photos');
      return { all: async () => photos };
    }
  };

  try {
    const result = await auditPhotoFiles(db, assetRoot);
    assert.deepEqual(result, {
      totalPhotos: 3,
      fullSizeFilesFound: 2,
      fullSizeFilesMissing: 1,
      thumbnailsFound: 1,
      thumbnailsMissing: 2,
      assetRoot
    });
    for (const filename of ['present-full.jpg', 'missing-full.jpg', 'present-thumb.jpg', 'missing-thumb.jpg']) {
      assert.equal(JSON.stringify(result).includes(filename), false);
    }
    assert.equal(await fs.promises.readFile(path.join(fullDirectory, 'present-full.jpg'), 'utf8'), 'full');
    assert.equal(await fs.promises.readFile(path.join(thumbDirectory, 'present-thumb.jpg'), 'utf8'), 'thumb');
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
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

test('filesystem diagnostic requires admin authorization and is a read-only GET route', async () => {
  const diagnosticPath = '/api/admin/diagnostics/storage-filesystem';
  const app = express();
  let handlerCalls = 0;
  app.use((req, _res, next) => {
    const role = req.get('x-test-role');
    req.session = role ? { user: { role } } : {};
    next();
  });
  app.get(diagnosticPath, requireAdmin, (_req, res) => {
    handlerCalls++;
    res.json({ ok: true });
  });

  const listener = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });

  try {
    const { port } = listener.address();
    const anonymousResponse = await fetch(`http://127.0.0.1:${port}${diagnosticPath}`);
    assert.equal(anonymousResponse.status, 403);

    const adminResponse = await fetch(`http://127.0.0.1:${port}${diagnosticPath}`, {
      headers: { 'x-test-role': 'admin' }
    });
    assert.equal(adminResponse.status, 200);
    assert.deepEqual(await adminResponse.json(), { ok: true });
    assert.equal(handlerCalls, 1);
  } finally {
    await new Promise((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    });
  }

  assert.match(
    serverSource,
    /app\.get\('\/api\/admin\/diagnostics\/storage-filesystem', requireAdmin, ok\(async \(_req, res\) => \{\s*res\.json\(await inspectFilesystemMetadata\(ASSET_ROOT\)\)/
  );
  assert.match(
    serverSource,
    /app\.get\('\/api\/admin\/diagnostics\/photo-file-audit', requireAdmin, ok\(async \(_req, res\) => \{\s*res\.json\(await auditPhotoFiles\(db, ASSET_ROOT\)\)/
  );
  assert.doesNotMatch(serverSource, /app\.post\('\/api\/admin\/diagnostics\/storage-filesystem'/);
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
