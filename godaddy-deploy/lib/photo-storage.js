'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEGACY_ASSET_ROOTS = Object.freeze([
  '/app/public/assets/pictureday',
  '/app/godaddy-deploy/public/assets/pictureday'
]);

function resolveAssetRoot(appRoot, assetDirectory) {
  return path.resolve(assetDirectory || path.join(appRoot, '..', 'public', 'assets', 'pictureday'));
}

function photoFilePath(directory, filename) {
  const basename = path.basename(filename || '');
  if (!basename || basename !== filename) throw new Error('Invalid stored photo filename.');
  return path.join(directory, basename);
}

async function isPhotoFilePresent(directory, filename) {
  if (!filename) return false;

  try {
    return (await fs.promises.stat(photoFilePath(directory, filename))).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function directoryExists(directory) {
  try {
    return (await fs.promises.stat(directory)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

async function countPhotoFiles(directory, photos, filenameProperty) {
  let count = 0;
  for (const photo of photos) {
    if (await isPhotoFilePresent(directory, photo[filenameProperty])) count++;
  }
  return count;
}

async function inspectPhotoStorageLocation(photos, assetRoot) {
  const fullDirectory = path.join(assetRoot, 'full');
  const thumbDirectory = path.join(assetRoot, 'thumb');
  const [exists, fullExists, thumbExists, fullSizeFilesFound, thumbnailsFound] = await Promise.all([
    directoryExists(assetRoot),
    directoryExists(fullDirectory),
    directoryExists(thumbDirectory),
    countPhotoFiles(fullDirectory, photos, 'file'),
    countPhotoFiles(thumbDirectory, photos, 'thumb')
  ]);

  return {
    exists,
    full: { exists: fullExists, matchingFiles: fullSizeFilesFound },
    thumb: { exists: thumbExists, matchingFiles: thumbnailsFound }
  };
}

async function auditPhotoFiles(db, assetRoot, { legacyAssetRoots = LEGACY_ASSET_ROOTS } = {}) {
  const photos = await db.prepare('SELECT file, thumb FROM photos').all();
  const counts = {
    totalPhotos: photos.length,
    fullSizeFilesFound: 0,
    fullSizeFilesMissing: 0,
    thumbnailsFound: 0,
    thumbnailsMissing: 0,
    assetRoot
  };

  const selectedLocation = await inspectPhotoStorageLocation(photos, assetRoot);
  counts.fullSizeFilesFound = selectedLocation.full.matchingFiles;
  counts.fullSizeFilesMissing = photos.length - counts.fullSizeFilesFound;
  counts.thumbnailsFound = selectedLocation.thumb.matchingFiles;
  counts.thumbnailsMissing = photos.length - counts.thumbnailsFound;
  counts.locations = {
    selectedAssetRoot: selectedLocation,
    legacyAppPublicAssets: await inspectPhotoStorageLocation(photos, legacyAssetRoots[0]),
    legacyGoDaddyDeployPublicAssets: await inspectPhotoStorageLocation(photos, legacyAssetRoots[1])
  };

  return counts;
}

function filesystemErrorReason(error) {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'not_found';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'permission_denied';
  return 'unavailable';
}

async function inspectFilesystemMetadata(
  assetRoot,
  {
    stat = fs.promises.stat,
    readFile = fs.promises.readFile,
    privatePath = '/private',
    privateAssetPath = '/private/pictureday',
    appPath = '/app',
    mountInfoPath = '/proc/self/mountinfo'
  } = {}
) {
  async function inspectPath(targetPath) {
    try {
      const result = await stat(targetPath);
      return {
        exists: true,
        isDirectory: result.isDirectory(),
        device: String(result.dev),
        error: null
      };
    } catch (error) {
      const reason = filesystemErrorReason(error);
      return {
        exists: reason === 'not_found' ? false : null,
        isDirectory: reason === 'not_found' ? false : null,
        device: null,
        error: reason
      };
    }
  }

  const [privateStatus, privateAssetStatus, appStatus] = await Promise.all([
    inspectPath(privatePath),
    inspectPath(privateAssetPath),
    inspectPath(appPath)
  ]);

  let privateMount = { available: false, reason: 'unavailable' };
  try {
    const contents = await readFile(mountInfoPath, 'utf8');
    const matchingMounts = [];
    for (const line of contents.split('\n')) {
      const separator = line.indexOf(' - ');
      if (separator < 0) continue;
      const beforeSeparator = line.slice(0, separator).split(' ');
      const afterSeparator = line.slice(separator + 3).split(' ');
      const mountPoint = beforeSeparator[4]?.replace(/\\([0-7]{3})/g, (_match, octal) =>
        String.fromCharCode(parseInt(octal, 8))
      );
      const relativePath = mountPoint && path.posix.relative(mountPoint, privatePath);
      if (
        !mountPoint ||
        !beforeSeparator[2] ||
        !afterSeparator[0] ||
        (relativePath !== '' &&
          (relativePath.startsWith('..') || path.posix.isAbsolute(relativePath)))
      ) {
        continue;
      }
      matchingMounts.push({
        mountPoint,
        filesystemType: afterSeparator[0],
        device: beforeSeparator[2]
      });
    }
    if (matchingMounts.length) {
      matchingMounts.sort((left, right) => right.mountPoint.length - left.mountPoint.length);
      privateMount = { available: true, ...matchingMounts[0] };
    } else {
      privateMount = { available: false, reason: 'not_found' };
    }
  } catch (error) {
    privateMount = { available: false, reason: filesystemErrorReason(error) };
  }

  return {
    assetRoot,
    directories: {
      private: {
        exists: privateStatus.exists,
        isDirectory: privateStatus.isDirectory,
        error: privateStatus.error
      },
      privatePictureday: {
        exists: privateAssetStatus.exists,
        isDirectory: privateAssetStatus.isDirectory,
        error: privateAssetStatus.error
      }
    },
    mount: { private: privateMount },
    devices: {
      private: {
        available: privateStatus.device !== null,
        device: privateStatus.device,
        reason: privateStatus.device === null ? privateStatus.error : null
      },
      app: {
        available: appStatus.device !== null,
        device: appStatus.device,
        reason: appStatus.device === null ? appStatus.error : null
      }
    }
  };
}

function denyPhotoAssetStaticAccess(req, res, next) {
  if (/^\/assets\/pictureday\/(?:full|thumb)(?:\/|$)/.test(req.path)) {
    return res.sendStatus(404);
  }
  return next();
}

module.exports = {
  resolveAssetRoot,
  photoFilePath,
  LEGACY_ASSET_ROOTS,
  auditPhotoFiles,
  inspectFilesystemMetadata,
  denyPhotoAssetStaticAccess
};
