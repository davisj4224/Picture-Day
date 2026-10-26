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
  ensureAssetDirectories,
  auditPhotoFiles,
  inspectFilesystemMetadata,
  LEGACY_ASSET_ROOTS,
  readStorageVerification,
  resolveAssetRoot
} = require('../lib/photo-storage');

const appRoot = path.join(path.sep, 'app', 'godaddy-deploy');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const photoRoutesSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'photo-routes.js'), 'utf8');
const uploadSecuritySource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'upload-security.js'), 'utf8');

test('production defaults to /private/pictureday when no asset directory is configured', () => {
  assert.equal(resolveAssetRoot(appRoot, '', 'production'), '/private/pictureday');
});

test('non-production keeps the existing app-root asset fallback', () => {
  assert.equal(
    resolveAssetRoot(appRoot, '', 'development'),
    path.join(path.sep, 'app', 'public', 'assets', 'pictureday')
  );
});

test('PICTUREDAY_ASSET_DIR overrides the fallback path', () => {
  const previous = process.env.PICTUREDAY_ASSET_DIR;
  try {
    process.env.PICTUREDAY_ASSET_DIR = '/private/pictureday';
    assert.equal(resolveAssetRoot(appRoot, undefined, 'production'), '/private/pictureday');
  } finally {
    if (previous === undefined) delete process.env.PICTUREDAY_ASSET_DIR;
    else process.env.PICTUREDAY_ASSET_DIR = previous;
  }
});

test('filesystem metadata reports resolved root, nearest mount, and device IDs without source details', async () => {
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

test('filesystem metadata explicitly reports missing paths and unreadable mount information', async () => {
  const missingPath = Object.assign(new Error('private path missing'), { code: 'ENOENT' });
  const denied = Object.assign(new Error('sensitive underlying details'), { code: 'EACCES' });
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
  assert.equal(JSON.stringify(result).includes('sensitive underlying details'), false);
});

test('filesystem metadata reports other filesystem errors without exposing error messages', async () => {
  const failure = Object.assign(new Error('private error detail'), { code: 'EIO' });
  const result = await inspectFilesystemMetadata('/private/pictureday', {
    stat: async () => {
      throw failure;
    },
    readFile: async () => {
      throw failure;
    }
  });

  assert.equal(result.directories.private.exists, null);
  assert.equal(result.directories.private.error, 'unavailable');
  assert.deepEqual(result.mount.private, { available: false, reason: 'unavailable' });
  assert.deepEqual(result.devices.app, {
    available: false,
    device: null,
    reason: 'unavailable'
  });
  assert.equal(JSON.stringify(result).includes('private error detail'), false);
});

test('asset directories are created recursively and checked for write access', async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pictureday-storage-test-'));
  const assetRoot = path.join(temporaryRoot, 'private', 'pictureday');

  try {
    const status = ensureAssetDirectories(assetRoot);
    assert.deepEqual(status, { path: assetRoot, exists: true, writable: true });
    for (const directory of ['full', 'thumb', 'brand']) {
      assert.equal(fs.statSync(path.join(assetRoot, directory)).isDirectory(), true);
    }
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('read-only storage verification does not create a missing test file', async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pictureday-storage-read-test-'));
  const assetRoot = path.join(temporaryRoot, 'assets');
  const testFile = path.join(assetRoot, 'pictureday-storage-test.txt');
  await fs.promises.mkdir(assetRoot);

  try {
    assert.deepEqual(await readStorageVerification(assetRoot), {
      path: testFile,
      exists: false,
      contents: null
    });
    assert.equal(fs.existsSync(testFile), false);
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('photo file audit returns only aggregate presence counts for stored file and thumbnail names', async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pictureday-photo-audit-test-'));
  const assetRoot = path.join(temporaryRoot, 'assets');
  const legacyAssetRoots = [path.join(temporaryRoot, 'legacy-app'), path.join(temporaryRoot, 'legacy-deploy')];
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
    const result = await auditPhotoFiles(db, assetRoot, { legacyAssetRoots });
    assert.deepEqual(result, {
      totalPhotos: 3,
      fullSizeFilesFound: 2,
      fullSizeFilesMissing: 1,
      thumbnailsFound: 1,
      thumbnailsMissing: 2,
      assetRoot,
      locations: {
        selectedAssetRoot: {
          exists: true,
          full: { exists: true, matchingFiles: 2 },
          thumb: { exists: true, matchingFiles: 1 }
        },
        legacyAppPublicAssets: {
          exists: false,
          full: { exists: false, matchingFiles: 0 },
          thumb: { exists: false, matchingFiles: 0 }
        },
        legacyGoDaddyDeployPublicAssets: {
          exists: false,
          full: { exists: false, matchingFiles: 0 },
          thumb: { exists: false, matchingFiles: 0 }
        }
      }
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

test('photo file audit checks both legacy roots without returning paths or filenames', async () => {
  assert.deepEqual(LEGACY_ASSET_ROOTS, [
    '/app/public/assets/pictureday',
    '/app/godaddy-deploy/public/assets/pictureday'
  ]);

  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pictureday-legacy-audit-test-'));
  const assetRoot = path.join(temporaryRoot, 'selected');
  const legacyAssetRoots = [
    path.join(temporaryRoot, 'legacy-app', 'public', 'assets', 'pictureday'),
    path.join(temporaryRoot, 'legacy-deploy', 'public', 'assets', 'pictureday')
  ];
  const photos = [
    {
      file: 'private-student-photo.jpg',
      thumb: 'private-student-thumbnail.jpg',
      student_name: 'Private Student'
    },
    { file: 'missing-private-photo.jpg', thumb: 'missing-private-thumbnail.jpg' }
  ];
  const db = {
    prepare(sql) {
      assert.equal(sql, 'SELECT file, thumb FROM photos');
      return { all: async () => photos };
    }
  };
  const firstFullDirectory = path.join(legacyAssetRoots[0], 'full');
  const secondThumbDirectory = path.join(legacyAssetRoots[1], 'thumb');
  await fs.promises.mkdir(firstFullDirectory, { recursive: true });
  await fs.promises.mkdir(secondThumbDirectory, { recursive: true });
  await fs.promises.writeFile(path.join(firstFullDirectory, photos[0].file), 'unchanged full photo');
  await fs.promises.writeFile(path.join(secondThumbDirectory, photos[0].thumb), 'unchanged thumbnail');

  try {
    const result = await auditPhotoFiles(db, assetRoot, { legacyAssetRoots });
    assert.deepEqual(result.locations, {
      selectedAssetRoot: {
        exists: false,
        full: { exists: false, matchingFiles: 0 },
        thumb: { exists: false, matchingFiles: 0 }
      },
      legacyAppPublicAssets: {
        exists: true,
        full: { exists: true, matchingFiles: 1 },
        thumb: { exists: false, matchingFiles: 0 }
      },
      legacyGoDaddyDeployPublicAssets: {
        exists: true,
        full: { exists: false, matchingFiles: 0 },
        thumb: { exists: true, matchingFiles: 1 }
      }
    });
    const responseBody = JSON.stringify(result);
    for (const filename of photos.flatMap(({ file, thumb }) => [file, thumb])) {
      assert.equal(responseBody.includes(filename), false);
    }
    assert.equal(responseBody.includes(legacyAssetRoots[0]), false);
    assert.equal(responseBody.includes(legacyAssetRoots[1]), false);
    assert.equal(responseBody.includes('Private Student'), false);
    assert.equal(
      await fs.promises.readFile(path.join(firstFullDirectory, photos[0].file), 'utf8'),
      'unchanged full photo'
    );
    assert.equal(
      await fs.promises.readFile(path.join(secondThumbDirectory, photos[0].thumb), 'utf8'),
      'unchanged thumbnail'
    );
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('read-only storage verification leaves an existing test file unchanged', async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pictureday-storage-read-test-'));
  const assetRoot = path.join(temporaryRoot, 'assets');
  const testFile = path.join(assetRoot, 'pictureday-storage-test.txt');
  const contents = 'existing verification contents';
  await fs.promises.mkdir(assetRoot);
  await fs.promises.writeFile(testFile, contents);
  const before = await fs.promises.stat(testFile);

  try {
    const originalWriteFile = fs.promises.writeFile;
    let writeAttempts = 0;
    fs.promises.writeFile = async () => {
      writeAttempts++;
      throw new Error('Read-only verification attempted a write.');
    };
    try {
      assert.deepEqual(await readStorageVerification(assetRoot), {
        path: testFile,
        exists: true,
        contents
      });
    } finally {
      fs.promises.writeFile = originalWriteFile;
    }
    assert.equal(writeAttempts, 0);
    const after = await fs.promises.stat(testFile);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
    assert.equal(await fs.promises.readFile(testFile, 'utf8'), contents);
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('Express returns 404 for direct full-photo and thumbnail asset requests', async () => {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pictureday-static-test-'));
  const publicDirectory = path.join(temporaryRoot, 'public');
  const server = express();

  try {
    for (const prefix of ['pictureday', path.join('assets', 'pictureday')]) {
      for (const directory of ['full', 'thumb']) {
        const fixtureDirectory = path.join(publicDirectory, prefix, directory);
        await fs.promises.mkdir(fixtureDirectory, { recursive: true });
        await fs.promises.writeFile(path.join(fixtureDirectory, 'fixture.jpg'), 'not a real photo');
      }
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
        for (const prefix of ['pictureday', 'assets/pictureday']) {
          const response = await fetch(`http://127.0.0.1:${port}/assets/${prefix}/${directory}/fixture.jpg`);
          assert.equal(response.status, 404, `${directory} files must not be served as static assets`);
        }
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

test('photo uploads, retrieval, and branding share the resolved asset root', () => {
  assert.match(serverSource, /const ASSET_ROOT = resolveAssetRoot\(ROOT, process\.env\.PICTUREDAY_ASSET_DIR\)/);
  assert.match(serverSource, /path\.join\(ASSET_ROOT, 'full'\)/);
  assert.match(serverSource, /path\.join\(ASSET_ROOT, 'thumb'\)/);
  assert.match(serverSource, /path\.join\(ASSET_ROOT, 'brand'\)/);
  assert.match(serverSource, /createPhotoUploadMiddleware\(\{ fullDirectory: UP_FULL, thumbDirectory: UP_THUMB \}\)/);
  assert.match(uploadSecuritySource, /file\.fieldname === 'thumb' \? thumbDirectory : fullDirectory/);
  assert.match(serverSource, /createBrandUploadMiddleware\(\{ brandDirectory: UP_BRAND \}\)/);
  assert.match(uploadSecuritySource, /destination: \(_req, _file, callback\) => callback\(null, brandDirectory\)/);
  assert.match(serverSource, /setSvgSafetyHeaders\(res, req\.params\.file\)/);
  assert.match(photoRoutesSource, /setSvgSafetyHeaders\(res, filePath\)/);
  assert.match(serverSource, /createStaffPhotoFileHandler\(\{ db, fullDirectory: UP_FULL, thumbDirectory: UP_THUMB \}\)/);
  assert.match(serverSource, /createGalleryPhotoFileHandler\(\{[\s\S]*fullDirectory: UP_FULL,[\s\S]*thumbDirectory: UP_THUMB/);
  assert.match(photoRoutesSource, /await findPhotoFile\(directory, filename, fallbackDirectories\)/);
  assert.match(serverSource, /app\.get\('\/brand\/:file'/);
  assert.match(serverSource, /const STORAGE_TEST_PATH = storageTestPath\(ASSET_ROOT\)/);
  assert.match(serverSource, /app\.get\('\/api\/admin\/diagnostics\/storage-read', requireAdmin/);
  assert.match(
    serverSource,
    /app\.get\('\/api\/admin\/diagnostics\/storage-read', requireAdmin, ok\(async \(_req, res\) => \{\s*res\.json\(await readStorageVerification\(ASSET_ROOT\)\)/
  );
  assert.match(
    serverSource,
    /app\.post\('\/api\/admin\/diagnostics\/storage-write', requireAdmin/
  );
  assert.match(serverSource, /writeFile\(STORAGE_TEST_PATH, STORAGE_TEST_CONTENTS/);
  assert.match(serverSource, /readStorageVerification\(ASSET_ROOT\)/);
  assert.match(serverSource, /Asset root \$\{assetStorage\.path\} exists=\$\{assetStorage\.exists\} writable=\$\{assetStorage\.writable\}/);
  assert.doesNotMatch(serverSource, /if \(!assetStorage\.exists \|\| !assetStorage\.writable\)[\s\S]{0,120}throw new Error/);
});

test('filesystem diagnostic rejects non-admins and allows an admin to reach its handler', async () => {
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
    assert.deepEqual(await anonymousResponse.json(), {
      error: 'Administrator access is required.'
    });

    const staffResponse = await fetch(`http://127.0.0.1:${port}${diagnosticPath}`, {
      headers: { 'x-test-role': 'staff' }
    });
    assert.equal(staffResponse.status, 403);

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
  assert.doesNotMatch(
    serverSource,
    /app\.post\('\/api\/admin\/diagnostics\/storage-filesystem'/
  );
});

test('photo file routes keep their staff and gallery authorization guards', () => {
  assert.match(serverSource, /app\.get\([\s\S]*'\/api\/photos\/:id\/file',\s*requireStaff/);
  assert.match(serverSource, /app\.get\([\s\S]*'\/api\/gallery\/:token\/photo\/:id',\s*galleryLimiter/);
  assert.match(
    photoRoutesSource,
    /WHERE id = \? AND student_id = \? AND published = 1 AND hidden = 0/
  );
  assert.match(photoRoutesSource, /createStaffPhotoFileHandler/);
  assert.match(photoRoutesSource, /createGalleryPhotoFileHandler/);
});
