'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');
const sharp = require('sharp');
const { restorePhotoFiles } = require('../lib/photo-restore');
const {
  createStaffPhotoFileHandler,
  createGalleryPhotoFileHandler
} = require('../lib/photo-routes');

class TestPhotoDatabase {
  constructor(photos) {
    this.photos = structuredClone(photos);
    this.students = [{
      id: 7,
      gallery_token: 'T'.repeat(32),
      qr_code: 'PD-2026-ABCD1234'
    }];
    this.queries = [];
  }

  snapshot() {
    return structuredClone({ photos: this.photos, students: this.students });
  }

  prepare(sql) {
    if (!sql.trimStart().startsWith('SELECT ')) {
      throw new Error(`Restore test database rejects non-read-only query: ${sql}`);
    }
    this.queries.push(sql);
    return {
      all: async () => structuredClone(this.photos),
      get: async (...parameters) => {
        const [photoId, studentId] = parameters.map(Number);
        return structuredClone(this.photos.find((photo) =>
          Number(photo.id) === photoId &&
          (studentId === undefined || (
            Number(photo.student_id) === studentId &&
            photo.published === 1 &&
            photo.hidden === 0
          ))
        ));
      }
    };
  }
}

async function createFixture(t, photoRows = [{
  id: 101,
  file: 'existing-full.jpg',
  thumb: 'existing-thumb.jpg',
  student_id: 7,
  qr_value: 'PD-2026-ABCD1234',
  published: 1,
  hidden: 0
}]) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pictureday-photo-restore-test-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  const fullDirectory = path.join(assetRoot, 'full');
  const thumbDirectory = path.join(assetRoot, 'thumb');
  const sourceDirectory = path.join(root, 'originals');
  await Promise.all([
    fs.promises.mkdir(fullDirectory, { recursive: true }),
    fs.promises.mkdir(thumbDirectory, { recursive: true }),
    fs.promises.mkdir(sourceDirectory, { recursive: true })
  ]);

  const source = path.join(sourceDirectory, 'camera-original.jpg');
  await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: { r: 40, g: 90, b: 170 }
    }
  }).jpeg({ quality: 90 }).toFile(source);
  const manifest = {
    photos: photoRows.map((photo, index) => ({
      photoId: photo.id,
      source: index === 0 ? 'camera-original.jpg' : `camera-original-${index + 1}.jpg`
    }))
  };
  for (let index = 1; index < photoRows.length; index++) {
    await fs.promises.copyFile(source, path.join(sourceDirectory, `camera-original-${index + 1}.jpg`));
  }

  return {
    root,
    assetRoot,
    fullDirectory,
    thumbDirectory,
    source,
    sourceDirectory,
    manifest,
    db: new TestPhotoDatabase(photoRows)
  };
}

test('manifest validation reports duplicate, unknown, ambiguous, and unmatched photo mappings', async (t) => {
  const photos = [
    { id: 1, file: 'one.jpg', thumb: 'one-thumb.jpg' },
    { id: 2, file: 'two.jpg', thumb: 'two-thumb.jpg' },
    { id: 3, file: 'three.jpg', thumb: 'three-thumb.jpg' }
  ];
  const fixture = await createFixture(t, photos);
  fixture.manifest = {
    photos: [
      { photoId: 1, source: 'camera-original.jpg' },
      { photoId: 1, source: 'camera-original.jpg' },
      { photoId: 2, source: 'camera-original.jpg' },
      { photoId: 999, source: 'camera-original.jpg' }
    ]
  };

  const report = await restorePhotoFiles({
    db: fixture.db,
    manifest: fixture.manifest,
    manifestDirectory: fixture.sourceDirectory,
    assetRoot: fixture.assetRoot
  });

  assert.equal(report.ready, false);
  assert.deepEqual(
    new Set(report.errors.map((error) => error.code)),
    new Set([
      'duplicate_photo_mapping',
      'ambiguous_source_mapping',
      'unknown_photo_id',
      'unmatched_photo_record'
    ])
  );
  assert.ok(report.errors.some((error) => error.photoId === '3'));
  assert.deepEqual(await fs.promises.readdir(fixture.fullDirectory), []);
  assert.deepEqual(await fs.promises.readdir(fixture.thumbDirectory), []);
});

test('dry-run validates all files and destinations without creating files', async (t) => {
  const fixture = await createFixture(t);
  const before = fixture.db.snapshot();
  const report = await restorePhotoFiles({
    db: fixture.db,
    manifest: fixture.manifest,
    manifestDirectory: fixture.sourceDirectory,
    assetRoot: fixture.assetRoot
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.ready, true);
  assert.equal(report.photoRecords, 1);
  assert.equal(report.wouldRestore.length, 1);
  assert.equal(report.wouldRestore[0].file, 'existing-full.jpg');
  assert.equal(report.wouldRestore[0].thumb, 'existing-thumb.jpg');
  assert.deepEqual(await fs.promises.readdir(fixture.fullDirectory), []);
  assert.deepEqual(await fs.promises.readdir(fixture.thumbDirectory), []);
  assert.deepEqual(fixture.db.snapshot(), before);
  assert.ok(fixture.db.queries.every((query) => query.trimStart().startsWith('SELECT ')));
});

test('preflight reports missing sources and unsafe stored filenames without writing', async (t) => {
  const fixture = await createFixture(t, [{
    id: 102,
    file: '../outside.jpg',
    thumb: 'stored-thumb.jpg'
  }]);
  fixture.manifest.photos[0].source = 'missing-original.jpg';
  const report = await restorePhotoFiles({
    db: fixture.db,
    manifest: fixture.manifest,
    manifestDirectory: fixture.sourceDirectory,
    assetRoot: fixture.assetRoot,
    apply: true
  });

  assert.equal(report.ready, false);
  assert.equal(report.restored.length, 0);
  assert.ok(report.errors.some((error) => error.code === 'invalid_destination'));
  assert.ok(report.errors.some((error) => error.code === 'source_unavailable'));
  assert.deepEqual(await fs.promises.readdir(fixture.fullDirectory), []);
  assert.deepEqual(await fs.promises.readdir(fixture.thumbDirectory), []);
});

test('restore copies the full original and creates a browser-sized JPEG thumbnail', async (t) => {
  const fixture = await createFixture(t);
  const before = fixture.db.snapshot();
  const sourceBytes = await fs.promises.readFile(fixture.source);

  const report = await restorePhotoFiles({
    db: fixture.db,
    manifest: fixture.manifest,
    manifestDirectory: fixture.sourceDirectory,
    assetRoot: fixture.assetRoot,
    apply: true
  });

  assert.equal(report.mode, 'restore');
  assert.equal(report.ready, true);
  assert.equal(report.restored.length, 1);
  assert.deepEqual(
    await fs.promises.readFile(path.join(fixture.fullDirectory, 'existing-full.jpg')),
    sourceBytes
  );
  const thumbnail = sharp(path.join(fixture.thumbDirectory, 'existing-thumb.jpg'));
  const metadata = await thumbnail.metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.ok(metadata.width <= 520 && metadata.height <= 520);
  assert.equal(metadata.width, 520);
  assert.deepEqual(fixture.db.snapshot(), before);
  assert.ok(fixture.db.queries.every((query) => query.trimStart().startsWith('SELECT ')));
});

test('restoration refuses existing destinations without changing their contents', async (t) => {
  const fixture = await createFixture(t);
  const fullPath = path.join(fixture.fullDirectory, 'existing-full.jpg');
  await fs.promises.writeFile(fullPath, 'keep existing content');
  const report = await restorePhotoFiles({
    db: fixture.db,
    manifest: fixture.manifest,
    manifestDirectory: fixture.sourceDirectory,
    assetRoot: fixture.assetRoot,
    apply: true
  });

  assert.equal(report.ready, false);
  assert.equal(report.restored.length, 0);
  assert.ok(report.errors.some((error) => error.code === 'destination_exists'));
  assert.equal(await fs.promises.readFile(fullPath, 'utf8'), 'keep existing content');
  assert.deepEqual(await fs.promises.readdir(fixture.thumbDirectory), []);
});

test('restored files are served through the existing staff and gallery handlers', async (t) => {
  const fixture = await createFixture(t);
  const before = fixture.db.snapshot();
  const report = await restorePhotoFiles({
    db: fixture.db,
    manifest: fixture.manifest,
    manifestDirectory: fixture.sourceDirectory,
    assetRoot: fixture.assetRoot,
    apply: true
  });
  assert.equal(report.ready, true);

  const app = express();
  const requireStaff = (req, res, next) =>
    req.get('x-test-staff') === 'yes' ? next() : res.sendStatus(401);
  const success = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  const galleryStudentByToken = async (_db, token) => ({
    status: token === 'T'.repeat(32) ? 'published' : 'not-found',
    student: { id: 7, first_name: 'Test', last_name: 'Student' }
  });

  app.get(
    '/api/photos/:id/file',
    requireStaff,
    success(createStaffPhotoFileHandler({
      db: fixture.db,
      fullDirectory: fixture.fullDirectory,
      thumbDirectory: fixture.thumbDirectory
    }))
  );
  app.get(
    '/api/gallery/:token/photo/:id',
    success(createGalleryPhotoFileHandler({
      db: fixture.db,
      galleryStudentByToken,
      fullDirectory: fixture.fullDirectory,
      thumbDirectory: fixture.thumbDirectory
    }))
  );
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  ));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${baseUrl}/api/photos/101/file`);
  assert.equal(unauthorized.status, 401);
  const staffFull = await fetch(`${baseUrl}/api/photos/101/file`, {
    headers: { 'x-test-staff': 'yes' }
  });
  const staffThumb = await fetch(`${baseUrl}/api/photos/101/file?size=thumb`, {
    headers: { 'x-test-staff': 'yes' }
  });
  const galleryFull = await fetch(`${baseUrl}/api/gallery/${'T'.repeat(32)}/photo/101`);
  const galleryThumb = await fetch(`${baseUrl}/api/gallery/${'T'.repeat(32)}/photo/101?size=thumb`);
  assert.equal(staffFull.status, 200);
  assert.equal(staffThumb.status, 200);
  assert.equal(galleryFull.status, 200);
  assert.equal(galleryThumb.status, 200);
  assert.deepEqual(Buffer.from(await staffFull.arrayBuffer()), await fs.promises.readFile(fixture.source));
  assert.equal(staffThumb.headers.get('content-type'), 'image/jpeg');
  assert.equal(galleryThumb.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(fixture.db.snapshot(), before);
});

test('staff and gallery retrieval fall back to legacy full-size and thumbnail locations', async (t) => {
  const fixture = await createFixture(t);
  const legacyRoots = [
    path.join(fixture.root, 'legacy-app', 'public', 'assets', 'pictureday'),
    path.join(fixture.root, 'legacy-deploy', 'public', 'assets', 'pictureday')
  ];
  const legacyFullDirectory = path.join(legacyRoots[0], 'full');
  const legacyThumbDirectory = path.join(legacyRoots[1], 'thumb');
  await Promise.all([
    fs.promises.mkdir(legacyFullDirectory, { recursive: true }),
    fs.promises.mkdir(legacyThumbDirectory, { recursive: true })
  ]);
  await fs.promises.copyFile(
    fixture.source,
    path.join(legacyFullDirectory, 'existing-full.jpg')
  );
  await sharp(fixture.source)
    .resize({ width: 520, height: 520, fit: 'inside', withoutEnlargement: true })
    .jpeg()
    .toFile(path.join(legacyThumbDirectory, 'existing-thumb.jpg'));

  const app = express();
  const requireStaff = (req, res, next) =>
    req.get('x-test-staff') === 'yes' ? next() : res.sendStatus(401);
  const success = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  const galleryStudentByToken = async (_db, token) => ({
    status: token === 'T'.repeat(32) ? 'published' : 'not-found',
    student: { id: 7, first_name: 'Test', last_name: 'Student' }
  });

  app.get(
    '/api/photos/:id/file',
    requireStaff,
    success(createStaffPhotoFileHandler({
      db: fixture.db,
      fullDirectory: fixture.fullDirectory,
      thumbDirectory: fixture.thumbDirectory,
      legacyAssetRoots: legacyRoots
    }))
  );
  app.get(
    '/api/gallery/:token/photo/:id',
    success(createGalleryPhotoFileHandler({
      db: fixture.db,
      galleryStudentByToken,
      fullDirectory: fixture.fullDirectory,
      thumbDirectory: fixture.thumbDirectory,
      legacyAssetRoots: legacyRoots
    }))
  );
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  ));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const before = fixture.db.snapshot();

  const unauthorized = await fetch(`${baseUrl}/api/photos/101/file?size=thumb`);
  const invalidGallery = await fetch(`${baseUrl}/api/gallery/invalid/photo/101?size=thumb`);
  const staffFull = await fetch(`${baseUrl}/api/photos/101/file`, {
    headers: { 'x-test-staff': 'yes' }
  });
  const staffThumb = await fetch(`${baseUrl}/api/photos/101/file?size=thumb`, {
    headers: { 'x-test-staff': 'yes' }
  });
  const galleryFull = await fetch(`${baseUrl}/api/gallery/${'T'.repeat(32)}/photo/101`);
  const galleryThumb = await fetch(`${baseUrl}/api/gallery/${'T'.repeat(32)}/photo/101?size=thumb`);
  assert.equal(unauthorized.status, 401);
  assert.equal(invalidGallery.status, 404);
  assert.equal(staffFull.status, 200);
  assert.equal(staffThumb.status, 200);
  assert.equal(galleryFull.status, 200);
  assert.equal(galleryThumb.status, 200);
  assert.deepEqual(Buffer.from(await staffFull.arrayBuffer()), await fs.promises.readFile(fixture.source));
  assert.equal(staffThumb.headers.get('content-type'), 'image/jpeg');
  assert.equal(galleryThumb.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(fixture.db.snapshot(), before);

  const primaryFullPath = path.join(fixture.fullDirectory, 'existing-full.jpg');
  await fs.promises.writeFile(primaryFullPath, 'configured root wins');
  const primaryWins = await fetch(`${baseUrl}/api/photos/101/file`, {
    headers: { 'x-test-staff': 'yes' }
  });
  assert.equal(primaryWins.status, 200);
  assert.equal(await primaryWins.text(), 'configured root wins');

  await fs.promises.rm(primaryFullPath);
  await fs.promises.rm(path.join(legacyFullDirectory, 'existing-full.jpg'));
  const allLocationsMissing = await fetch(`${baseUrl}/api/photos/101/file`, {
    headers: { 'x-test-staff': 'yes' }
  });
  assert.equal(allLocationsMissing.status, 404);
  assert.deepEqual(fixture.db.snapshot(), before);
});
