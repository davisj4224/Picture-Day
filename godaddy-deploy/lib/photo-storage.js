'use strict';

const path = require('node:path');

function resolveAssetRoot(appRoot, assetDirectory) {
  return path.resolve(assetDirectory || path.join(appRoot, '..', 'public', 'assets', 'pictureday'));
}

function denyPhotoAssetStaticAccess(req, res, next) {
  if (/^\/assets\/pictureday\/(?:full|thumb)(?:\/|$)/.test(req.path)) {
    return res.sendStatus(404);
  }
  return next();
}

module.exports = { resolveAssetRoot, denyPhotoAssetStaticAccess };
