'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const sharp = require('sharp');
const { photoFilePath } = require('./photo-storage');

const THUMBNAIL_SIZE = 520;
const THUMBNAIL_QUALITY = 72;
const EXTENSIONS_BY_FORMAT = {
  jpeg: ['.jpg', '.jpeg'],
  png: ['.png'],
  webp: ['.webp'],
  tiff: ['.tif', '.tiff'],
  gif: ['.gif'],
  avif: ['.avif'],
  heif: ['.heic', '.heif']
};

function addError(errors, code, message, photoId = null) {
  errors.push({ code, message, photoId });
}

function photoIdKey(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

function manifestPhotoId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}

function storedPhotoPath(directory, filename) {
  if (
    typeof filename !== 'string' ||
    !filename ||
    filename === '.' ||
    filename === '..' ||
    filename !== path.basename(filename) ||
    /[\\/\x00-\x1f\x7f]/.test(filename)
  ) {
    throw new Error('Invalid stored photo filename.');
  }
  return photoFilePath(directory, filename);
}

async function inspectDestination(directory, filename, errors, photoId, label) {
  let destination;
  try {
    destination = storedPhotoPath(directory, filename);
  } catch (error) {
    addError(errors, 'invalid_destination', `${label}: ${error.message}`, photoId);
    return null;
  }

  try {
    await fs.promises.lstat(destination);
    addError(errors, 'destination_exists', `${label} already exists; refusing to overwrite it.`, photoId);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      addError(errors, 'destination_unavailable', `${label}: ${error.message}`, photoId);
    }
  }
  return destination;
}

async function inspectDirectory(directory, errors, label) {
  try {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      addError(errors, 'invalid_asset_directory', `${label} must be a real directory, not a symbolic link.`);
      return;
    }
    await fs.promises.access(directory, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    addError(errors, 'asset_directory_unavailable', `${label}: ${error.message}`);
  }
}

function validateFileExtension(filename, format, photoId, errors) {
  const expected = EXTENSIONS_BY_FORMAT[format];
  const extension = path.extname(filename).toLowerCase();
  if (!expected || !expected.includes(extension)) {
    addError(
      errors,
      'image_extension_mismatch',
      `Stored full-size filename extension "${extension || '(none)'}" does not match source image format "${format}".`,
      photoId
    );
  }
}

async function buildRestorePlan({ db, manifest, manifestDirectory, assetRoot }) {
  const errors = [];
  const photos = await db.prepare('SELECT id, file, thumb FROM photos ORDER BY id').all();
  const fullDirectory = path.join(assetRoot, 'full');
  const thumbDirectory = path.join(assetRoot, 'thumb');
  await Promise.all([
    inspectDirectory(fullDirectory, errors, 'Full-size asset directory'),
    inspectDirectory(thumbDirectory, errors, 'Thumbnail asset directory')
  ]);

  const photosById = new Map();
  const destinations = new Map();
  for (const photo of photos) {
    const key = photoIdKey(photo.id);
    if (!key) {
      addError(errors, 'invalid_database_photo_id', `Database photo ID "${photo.id}" is not a safe positive integer.`);
      continue;
    }
    if (photosById.has(key)) {
      addError(errors, 'duplicate_database_photo_id', `Database contains duplicate photo ID ${key}.`, key);
    }
    photosById.set(key, photo);

    for (const [kind, directory, filename] of [
      ['full', fullDirectory, photo.file],
      ['thumb', thumbDirectory, photo.thumb]
    ]) {
      if (filename == null && kind === 'thumb') continue;
      try {
        const destination = storedPhotoPath(directory, filename);
        const destinationKey = `${kind}:${destination}`;
        if (destinations.has(destinationKey)) {
          addError(
            errors,
            'duplicate_destination',
            `Photo ${key} and photo ${destinations.get(destinationKey)} share the same ${kind} destination.`,
            key
          );
        } else {
          destinations.set(destinationKey, key);
        }
      } catch (error) {
        addError(errors, 'invalid_destination', `Photo ${key} ${kind} filename: ${error.message}`, key);
      }
    }
  }

  if (!manifest || !Array.isArray(manifest.photos)) {
    addError(errors, 'invalid_manifest', 'Manifest must be a JSON object with a photos array.');
    return { photos, errors, entries: [], fullDirectory, thumbDirectory };
  }

  const countsById = new Map();
  const entries = [];
  for (const [index, mapping] of manifest.photos.entries()) {
    const key = manifestPhotoId(mapping?.photoId);
    if (!key) {
      addError(errors, 'invalid_photo_id', `Manifest entry ${index + 1} has an invalid photoId.`);
      continue;
    }
    countsById.set(key, (countsById.get(key) || 0) + 1);
    const photo = photosById.get(key);
    if (!photo) {
      addError(errors, 'unknown_photo_id', `Manifest photoId ${key} does not exist in the database.`, key);
      continue;
    }
    if (typeof mapping.source !== 'string' || !mapping.source.trim()) {
      addError(errors, 'invalid_source', `Manifest entry for photo ${key} has no source path.`, key);
      continue;
    }
    entries.push({
      photoId: key,
      photo,
      source: path.resolve(manifestDirectory, mapping.source)
    });
  }

  for (const [key, count] of countsById) {
    if (count > 1) {
      addError(errors, 'duplicate_photo_mapping', `Manifest maps photo ${key} ${count} times.`, key);
    }
  }
  for (const photo of photos) {
    const key = photoIdKey(photo.id);
    if (key && !countsById.has(key)) {
      addError(errors, 'unmatched_photo_record', `Database photo ${key} has no manifest mapping.`, key);
    }
  }

  const sources = new Map();
  for (const entry of entries) {
    try {
      const realSource = await fs.promises.realpath(entry.source);
      const stat = await fs.promises.stat(realSource);
      if (!stat.isFile()) {
        addError(errors, 'source_not_file', `Source for photo ${entry.photoId} is not a regular file.`, entry.photoId);
        continue;
      }
      if (sources.has(realSource)) {
        addError(
          errors,
          'ambiguous_source_mapping',
          `Source file is mapped to both photo ${sources.get(realSource)} and photo ${entry.photoId}.`,
          entry.photoId
        );
      } else {
        sources.set(realSource, entry.photoId);
      }
      entry.source = realSource;
      const metadata = await sharp(realSource).metadata();
      if (!metadata.width || !metadata.height || !metadata.format) {
        addError(errors, 'invalid_image_source', `Source for photo ${entry.photoId} is not a supported image.`, entry.photoId);
        continue;
      }
      entry.metadata = metadata;
      validateFileExtension(entry.photo.file, metadata.format, entry.photoId, errors);
    } catch (error) {
      addError(errors, 'source_unavailable', `Source for photo ${entry.photoId}: ${error.message}`, entry.photoId);
    }

    await inspectDestination(fullDirectory, entry.photo.file, errors, entry.photoId, 'Full-size destination');
    if (entry.photo.thumb != null) {
      const thumbPath = await inspectDestination(
        thumbDirectory,
        entry.photo.thumb,
        errors,
        entry.photoId,
        'Thumbnail destination'
      );
      if (thumbPath && !['.jpg', '.jpeg'].includes(path.extname(thumbPath).toLowerCase())) {
        addError(
          errors,
          'invalid_thumbnail_extension',
          'Stored thumbnail filename must use a .jpg or .jpeg extension.',
          entry.photoId
        );
      }
    }
  }

  return { photos, errors, entries, fullDirectory, thumbDirectory };
}

function summarizePlan(plan) {
  const wouldRestore = plan.entries.map((entry) => ({
    photoId: entry.photoId,
    source: entry.source,
    file: entry.photo.file,
    thumb: entry.photo.thumb || null
  }));
  const skipped = plan.entries
    .filter((entry) => entry.photo.thumb == null)
    .map((entry) => ({ photoId: entry.photoId, reason: 'No thumbnail filename is stored in this photo record.' }));
  return {
    ready: plan.errors.length === 0,
    photoRecords: plan.photos.length,
    manifestEntries: plan.entries.length,
    wouldRestore,
    skipped,
    failed: plan.errors.map((error) => ({
      photoId: error.photoId,
      reason: `${error.code}: ${error.message}`
    })),
    errors: plan.errors
  };
}

function temporaryPath(directory) {
  return path.join(directory, `.pictureday-restore-${process.pid}-${crypto.randomBytes(12).toString('hex')}.tmp`);
}

async function writeFullTemporary(source, directory) {
  const temporary = temporaryPath(directory);
  const output = fs.createWriteStream(temporary, { flags: 'wx' });
  try {
    await pipeline(fs.createReadStream(source), output);
    return temporary;
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
}

async function writeThumbnailTemporary(source, directory) {
  const temporary = temporaryPath(directory);
  try {
    const handle = await fs.promises.open(temporary, 'wx');
    await handle.close();
    await sharp(source)
      .rotate()
      .resize({
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: THUMBNAIL_QUALITY })
      .toFile(temporary);
    return temporary;
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
}

async function installWithoutOverwrite(temporary, destination) {
  await fs.promises.link(temporary, destination);
}

async function restoreEntry(entry, plan) {
  const fullPath = storedPhotoPath(plan.fullDirectory, entry.photo.file);
  const thumbPath = entry.photo.thumb == null
    ? null
    : storedPhotoPath(plan.thumbDirectory, entry.photo.thumb);
  let fullInstalled = false;
  let thumbInstalled = false;
  let fullTemporary;
  let thumbTemporary;
  try {
    fullTemporary = await writeFullTemporary(entry.source, plan.fullDirectory);
    await installWithoutOverwrite(fullTemporary, fullPath);
    fullInstalled = true;
    await fs.promises.unlink(fullTemporary);
    fullTemporary = null;

    if (thumbPath) {
      thumbTemporary = await writeThumbnailTemporary(entry.source, plan.thumbDirectory);
      await installWithoutOverwrite(thumbTemporary, thumbPath);
      thumbInstalled = true;
      await fs.promises.unlink(thumbTemporary);
      thumbTemporary = null;
    }
    return { photoId: entry.photoId, file: entry.photo.file, thumb: entry.photo.thumb || null };
  } catch (error) {
    if (thumbInstalled) {
      try {
        await fs.promises.unlink(thumbPath);
      } catch (cleanupError) {
        error.message += `; could not roll back newly restored thumbnail: ${cleanupError.message}`;
      }
    }
    if (fullInstalled) {
      try {
        await fs.promises.unlink(fullPath);
      } catch (cleanupError) {
        error.message += `; could not roll back newly restored full-size file: ${cleanupError.message}`;
      }
    }
    throw error;
  } finally {
    await Promise.all(
      [fullTemporary, thumbTemporary]
        .filter(Boolean)
        .map((temporary) => fs.promises.rm(temporary, { force: true }))
    );
  }
}

async function restorePhotoFiles({ db, manifest, manifestDirectory, assetRoot, apply = false }) {
  const plan = await buildRestorePlan({ db, manifest, manifestDirectory, assetRoot });
  const report = summarizePlan(plan);
  report.mode = apply ? 'restore' : 'dry-run';
  report.assetRoot = assetRoot;
  report.restored = [];

  if (!report.ready || !apply) return report;

  report.wouldRestore = [];
  report.skipped = [];
  report.failed = [];
  for (const entry of plan.entries) {
    try {
      report.restored.push(await restoreEntry(entry, plan));
      if (entry.photo.thumb == null) {
        report.skipped.push({
          photoId: entry.photoId,
          reason: 'No thumbnail filename is stored in this photo record.'
        });
      }
    } catch (error) {
      report.failed.push({ photoId: entry.photoId, reason: error.message });
    }
  }
  report.ready = report.failed.length === 0;
  return report;
}

module.exports = {
  buildRestorePlan,
  restorePhotoFiles,
  THUMBNAIL_SIZE,
  THUMBNAIL_QUALITY
};
