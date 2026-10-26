'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');
const sharp = require('sharp');
const {
  BRAND_UPLOAD_LIMIT_BYTES,
  PHOTO_UPLOAD_LIMIT_BYTES,
  createBrandUploadMiddleware,
  createPhotoUploadMiddleware,
  persistBrandUpload,
  persistPhotoUpload,
  promoteUploadedImage,
  setSvgSafetyHeaders,
  uploadErrorStatus
} = require('../lib/upload-security');

async function makeImage(format) {
  return sharp({
    create: {
      width: 3,
      height: 2,
      channels: 3,
      background: { r: 36, g: 82, b: 120 }
    }
  }).toFormat(format).toBuffer();
}

async function makeStagedFile(directory, originalname, mimetype, contents) {
  const filename = `${crypto.randomBytes(16).toString('hex')}.upload`;
  const filePath = path.join(directory, filename);
  await fs.promises.writeFile(filePath, contents);
  return {
    destination: directory,
    filename,
    path: filePath,
    originalname,
    mimetype,
    size: contents.length
  };
}

async function makeDirectories() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pictureday-upload-test-'));
  const full = path.join(root, 'full');
  const thumb = path.join(root, 'thumb');
  const brand = path.join(root, 'brand');
  await Promise.all([full, thumb, brand].map((directory) => fs.promises.mkdir(directory)));
  return { root, full, thumb, brand };
}

test('photo uploads use content rather than filename extension or declared MIME type', async (t) => {
  const directories = await makeDirectories();
  t.after(() => fs.promises.rm(directories.root, { recursive: true, force: true }));

  const png = await makeImage('png');
  const mislabeled = await makeStagedFile(
    directories.full,
    '../../portrait.jpg',
    'image/gif',
    png
  );
  const { photo } = await persistPhotoUpload({
    file: mislabeled,
    persist: async (savedPhoto) => ({ file: savedPhoto.filename })
  });

  assert.equal(path.extname(photo.filename), '.png');
  assert.match(photo.filename, /^[a-f0-9]{32}\.png$/);
  assert.equal(path.dirname(photo.path), directories.full);
  assert.equal(photo.detectedFormat, 'png');
  assert.equal(photo.verified, true);
  assert.deepEqual(await fs.promises.readFile(photo.path), png);

  const jpeg = await makeImage('jpeg');
  const wrongMime = await makeStagedFile(directories.full, 'portrait.png', 'text/plain', jpeg);
  const normalized = await promoteUploadedImage(wrongMime);
  assert.equal(path.extname(normalized.filename), '.jpg');
  assert.equal(normalized.detectedFormat, 'jpeg');
  await fs.promises.rm(normalized.path, { force: true });
});

test('malformed known image files are rejected and removed', async (t) => {
  const directories = await makeDirectories();
  t.after(() => fs.promises.rm(directories.root, { recursive: true, force: true }));

  const file = await makeStagedFile(
    directories.full,
    'broken.jpg',
    'image/jpeg',
    Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])
  );

  await assert.rejects(
    persistPhotoUpload({ file, persist: async () => assert.fail('invalid image must not be persisted') }),
    { code: 'INVALID_IMAGE', status: 400 }
  );
  assert.deepEqual(await fs.promises.readdir(directories.full), []);
});

test('unrecognized content is rejected even when named and typed as an image', async (t) => {
  const directories = await makeDirectories();
  t.after(() => fs.promises.rm(directories.root, { recursive: true, force: true }));

  const file = await makeStagedFile(
    directories.full,
    'payload.jpg',
    'image/jpeg',
    Buffer.from('<html><script>invalid image</script></html>')
  );
  await assert.rejects(
    persistPhotoUpload({
      file,
      persist: async () => assert.fail('unrecognized content must not be persisted')
    }),
    {
      code: 'INVALID_IMAGE',
      status: 400,
      message: /Additional camera formats must be verified before support can be added/
    }
  );
  assert.deepEqual(await fs.promises.readdir(directories.full), []);
});

test('photo files are removed if thumbnail validation or database persistence fails', async (t) => {
  const directories = await makeDirectories();
  t.after(() => fs.promises.rm(directories.root, { recursive: true, force: true }));

  const photo = await makeStagedFile(directories.full, 'portrait.jpg', 'image/jpeg', await makeImage('jpeg'));
  const invalidThumb = await makeStagedFile(directories.thumb, 'thumb.jpg', 'image/jpeg', Buffer.from('bad'));
  await assert.rejects(
    persistPhotoUpload({
      file: photo,
      thumb: invalidThumb,
      persist: async () => assert.fail('invalid thumbnail must not be persisted')
    }),
    { code: 'INVALID_IMAGE', status: 400 }
  );
  assert.deepEqual(await fs.promises.readdir(directories.full), []);
  assert.deepEqual(await fs.promises.readdir(directories.thumb), []);

  const secondPhoto = await makeStagedFile(directories.full, 'portrait.jpg', 'image/jpeg', await makeImage('jpeg'));
  const secondThumb = await makeStagedFile(directories.thumb, 'thumb.jpg', 'image/jpeg', await makeImage('jpeg'));
  await assert.rejects(
    persistPhotoUpload({
      file: secondPhoto,
      thumb: secondThumb,
      persist: async () => {
        throw new Error('synthetic database failure');
      }
    }),
    /synthetic database failure/
  );
  assert.deepEqual(await fs.promises.readdir(directories.full), []);
  assert.deepEqual(await fs.promises.readdir(directories.thumb), []);
});

test('photo destination collisions fail without overwriting existing files', async (t) => {
  const directories = await makeDirectories();
  t.after(() => fs.promises.rm(directories.root, { recursive: true, force: true }));

  const file = await makeStagedFile(directories.full, 'portrait.png', 'image/png', await makeImage('png'));
  const existingPath = path.join(directories.full, `${file.filename.slice(0, -'.upload'.length)}.png`);
  const originalContents = Buffer.from('pre-existing destination');
  await fs.promises.writeFile(existingPath, originalContents);

  await assert.rejects(
    persistPhotoUpload({ file, persist: async () => assert.fail('collision must not be persisted') }),
    { code: 'EEXIST' }
  );
  assert.deepEqual(await fs.promises.readFile(existingPath), originalContents);
  assert.deepEqual(await fs.promises.readdir(directories.full), [path.basename(existingPath)]);
});

test('branding images are validated by content and canonicalized before persistence', async (t) => {
  const directories = await makeDirectories();
  t.after(() => fs.promises.rm(directories.root, { recursive: true, force: true }));

  const png = await makeImage('png');
  const file = await makeStagedFile(directories.brand, '../../brand.html', 'text/html', png);
  const { image, result } = await persistBrandUpload({
    file,
    persist: async (savedImage) => ({ filename: savedImage.filename })
  });

  assert.equal(path.extname(image.filename), '.png');
  assert.equal(image.detectedFormat, 'png');
  assert.equal(result.filename, image.filename);
  assert.deepEqual(await fs.promises.readFile(image.path), png);

  const malformed = await makeStagedFile(directories.brand, 'broken.png', 'image/png', Buffer.from('not an image'));
  await assert.rejects(
    persistBrandUpload({ file: malformed, persist: async () => assert.fail('invalid branding image was persisted') }),
    { code: 'INVALID_IMAGE', status: 400 }
  );
  assert.deepEqual(await fs.promises.readdir(directories.brand), [image.filename]);

  const failedSave = await makeStagedFile(directories.brand, 'logo.png', 'image/png', png);
  await assert.rejects(
    persistBrandUpload({
      file: failedSave,
      persist: async () => {
        throw new Error('synthetic settings failure');
      }
    }),
    /synthetic settings failure/
  );
  assert.deepEqual(await fs.promises.readdir(directories.brand), [image.filename]);
});

test('SVG delivery is sandboxed and the production photo upload limit remains 60 MiB', () => {
  let policy;
  const response = { setHeader: (_name, value) => { policy = value; } };
  setSvgSafetyHeaders(response, 'brand.svg');
  assert.match(policy, /sandbox/);
  assert.match(policy, /default-src 'none'/);

  setSvgSafetyHeaders(response, 'portrait.jpg');
  assert.equal(uploadErrorStatus({ code: 'LIMIT_FILE_SIZE' }), 413);
  assert.equal(PHOTO_UPLOAD_LIMIT_BYTES, 60 * 1024 * 1024);
  assert.equal(BRAND_UPLOAD_LIMIT_BYTES, 4 * 1024 * 1024);
});

test('photo upload middleware rejects oversized bodies and removes partial files', async (t) => {
  const directories = await makeDirectories();
  const app = express();
  app.post(
    '/upload',
    createPhotoUploadMiddleware({
      fullDirectory: directories.full,
      thumbDirectory: directories.thumb,
      maxFileSize: 8
    }),
    (_req, res) => res.sendStatus(204)
  );
  app.use((error, _req, res, _next) => res.sendStatus(uploadErrorStatus(error)));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.promises.rm(directories.root, { recursive: true, force: true });
  });

  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(9)], { type: 'image/jpeg' }), 'too-large.jpg');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/upload`, {
    method: 'POST',
    body: form
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await fs.promises.readdir(directories.full), []);
  assert.deepEqual(await fs.promises.readdir(directories.thumb), []);
});

test('branding upload middleware rejects oversized bodies and removes partial files', async (t) => {
  const directories = await makeDirectories();
  const app = express();
  app.post(
    '/upload',
    createBrandUploadMiddleware({ brandDirectory: directories.brand, maxFileSize: 8 }),
    (_req, res) => res.sendStatus(204)
  );
  app.use((error, _req, res, _next) => res.sendStatus(uploadErrorStatus(error)));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.promises.rm(directories.root, { recursive: true, force: true });
  });

  const form = new FormData();
  form.append('image', new Blob([Buffer.alloc(9)], { type: 'image/png' }), 'too-large.png');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/upload`, {
    method: 'POST',
    body: form
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await fs.promises.readdir(directories.brand), []);
});
