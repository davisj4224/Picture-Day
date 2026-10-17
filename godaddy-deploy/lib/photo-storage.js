'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveAssetRoot(appRoot, assetDirectory) {
  return path.resolve(assetDirectory || path.join(appRoot, '..', 'public', 'assets', 'pictureday'));
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
  inspectFilesystemMetadata,
  denyPhotoAssetStaticAccess
};
