'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const sharp = require('sharp');

const PHOTO_UPLOAD_LIMIT_BYTES = 60 * 1024 * 1024;
const BRAND_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
const EXTENSIONS_BY_FORMAT = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  tiff: '.tif',
  gif: '.gif',
  avif: '.avif',
  heif: '.heic',
  svg: '.svg',
  bmp: '.bmp'
};
const BRAND_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp', 'svg']);
const UNVERIFIED_IMAGE_MESSAGE =
  'The uploaded image could not be verified. Use a supported image format. Additional camera formats must be verified before support can be added.';

function uploadError(message) {
  const error = new Error(message);
  error.code = 'INVALID_IMAGE';
  error.status = 400;
  return error;
}

function requestUploadName(req) {
  if (!req.pictureDayUploadName) {
    req.pictureDayUploadName = crypto.randomBytes(16).toString('hex');
  }
  return req.pictureDayUploadName;
}

function createPhotoUploadMiddleware({ fullDirectory, thumbDirectory, maxFileSize = PHOTO_UPLOAD_LIMIT_BYTES }) {
  const storage = multer.diskStorage({
    destination: (req, file, callback) =>
      callback(null, file.fieldname === 'thumb' ? thumbDirectory : fullDirectory),
    filename: (req, _file, callback) => callback(null, `${requestUploadName(req)}.upload`)
  });

  return multer({
    storage,
    limits: { fileSize: maxFileSize, files: 2 }
  }).fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]);
}

function createBrandUploadMiddleware({ brandDirectory, maxFileSize = BRAND_UPLOAD_LIMIT_BYTES }) {
  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, brandDirectory),
    filename: (_req, _file, callback) =>
      callback(null, `${crypto.randomBytes(16).toString('hex')}.upload`)
  });

  return multer({
    storage,
    limits: { fileSize: maxFileSize, files: 1 }
  }).single('image');
}

async function inspectImage(file, { allowedFormats } = {}) {
  if (!file || typeof file.path !== 'string' || typeof file.originalname !== 'string') {
    throw uploadError('The uploaded file could not be checked.');
  }

  const options = { failOn: 'error' };
  let metadata;

  try {
    metadata = await sharp(file.path, options).metadata();
  } catch {
    throw uploadError(UNVERIFIED_IMAGE_MESSAGE);
  }

  const format = metadata.format;
  if (!format || !EXTENSIONS_BY_FORMAT[format]) {
    throw uploadError(UNVERIFIED_IMAGE_MESSAGE);
  }
  if (allowedFormats && !allowedFormats.has(format)) {
    throw uploadError('Use a PNG, JPG, GIF, WEBP or SVG image.');
  }

  try {
    await sharp(file.path, options)
      .rotate()
      .resize({ width: 1, height: 1, fit: 'inside' })
      .toBuffer();
  } catch {
    throw uploadError('The uploaded image is malformed or incomplete.');
  }

  return { format, extension: EXTENSIONS_BY_FORMAT[format], verified: true };
}

function temporaryUploadBase(file) {
  if (
    typeof file.filename !== 'string' ||
    !/^[a-f0-9]{32}\.upload$/.test(file.filename) ||
    path.basename(file.filename) !== file.filename ||
    path.resolve(file.path) !== path.resolve(path.join(file.destination, file.filename))
  ) {
    throw uploadError('The uploaded file has an invalid temporary path.');
  }
  return file.filename.slice(0, -'.upload'.length);
}

async function promoteUploadedImage(file, options) {
  const inspected = await inspectImage(file, options);
  const base = temporaryUploadBase(file);
  const filename = `${base}${inspected.extension}`;
  const destination = path.join(file.destination, filename);

  if (destination !== file.path) {
    await fs.promises.copyFile(file.path, destination, fs.constants.COPYFILE_EXCL);
    try {
      await fs.promises.unlink(file.path);
    } catch (error) {
      await fs.promises.rm(destination, { force: true }).catch((cleanupError) => {
        console.error('[upload] Could not remove a partially promoted file:', cleanupError.message);
      });
      throw error;
    }
  }

  return { ...file, filename, path: destination, detectedFormat: inspected.format, verified: inspected.verified };
}

async function removeUploadedFiles(paths) {
  const errors = [];
  for (const filePath of new Set(paths)) {
    if (!filePath) continue;
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'One or more temporary upload files could not be removed.');
}

async function cleanAfterUploadFailure(paths, error) {
  try {
    await removeUploadedFiles(paths);
  } catch (cleanupError) {
    console.error('[upload] Could not clean up a rejected upload:', cleanupError.message);
  }
  throw error;
}

async function persistPhotoUpload({ file, thumb, persist }) {
  const cleanupPaths = new Set([file?.path, thumb?.path]);
  try {
    if (!file) throw uploadError('No photo was received.');
    const photo = await promoteUploadedImage(file);
    cleanupPaths.add(photo.path);

    let thumbnail = null;
    if (thumb) {
      thumbnail = await promoteUploadedImage(thumb, {
        allowedFormats: new Set(['jpeg'])
      });
      cleanupPaths.add(thumbnail.path);
    }

    const result = await persist(photo, thumbnail);
    return { result, photo, thumbnail };
  } catch (error) {
    return cleanAfterUploadFailure(cleanupPaths, error);
  }
}

async function persistBrandUpload({ file, persist }) {
  const cleanupPaths = new Set([file?.path]);
  try {
    if (!file) throw uploadError('No image was received.');
    const image = await promoteUploadedImage(file, {
      allowedFormats: BRAND_FORMATS
    });
    cleanupPaths.add(image.path);
    const result = await persist(image);
    return { result, image };
  } catch (error) {
    return cleanAfterUploadFailure(cleanupPaths, error);
  }
}

function uploadErrorStatus(error) {
  if (error?.code === 'LIMIT_FILE_SIZE') return 413;
  if (typeof error?.code === 'string' && error.code.startsWith('LIMIT_')) return 400;
  return error?.status || 500;
}

function setSvgSafetyHeaders(res, filename) {
  if (path.extname(filename || '').toLowerCase() === '.svg') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"
    );
  }
}

module.exports = {
  BRAND_UPLOAD_LIMIT_BYTES,
  PHOTO_UPLOAD_LIMIT_BYTES,
  createBrandUploadMiddleware,
  createPhotoUploadMiddleware,
  persistBrandUpload,
  persistPhotoUpload,
  promoteUploadedImage,
  setSvgSafetyHeaders,
  uploadErrorStatus
};
