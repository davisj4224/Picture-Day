'use strict';

const path = require('node:path');
const { findPhotoFile, LEGACY_ASSET_ROOTS } = require('./photo-storage');

async function sendPhotoFile(res, photo, req, fullDirectory, thumbDirectory, legacyAssetRoots) {
  const useThumbnail = req.query.size === 'thumb' && photo.thumb;
  const directory = useThumbnail ? thumbDirectory : fullDirectory;
  const filename = useThumbnail ? photo.thumb : photo.file;
  const subdirectory = useThumbnail ? 'thumb' : 'full';
  const fallbackDirectories = legacyAssetRoots.map((root) => path.join(root, subdirectory));
  const filePath = await findPhotoFile(directory, filename, fallbackDirectories);
  if (!filePath) return res.sendStatus(404);

  return res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) res.sendStatus(error.code === 'ENOENT' ? 404 : 500);
  });
}

function createStaffPhotoFileHandler({
  db,
  fullDirectory,
  thumbDirectory,
  legacyAssetRoots = LEGACY_ASSET_ROOTS
}) {
  return async (req, res) => {
    const photo = await db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
    if (!photo) return res.sendStatus(404);
    return sendPhotoFile(res, photo, req, fullDirectory, thumbDirectory, legacyAssetRoots);
  };
}

function createGalleryPhotoFileHandler({
  db,
  galleryStudentByToken,
  fullDirectory,
  thumbDirectory,
  legacyAssetRoots = LEGACY_ASSET_ROOTS
}) {
  return async (req, res) => {
    const gallery = await galleryStudentByToken(db, req.params.token);
    if (gallery.status === 'not-found') return res.sendStatus(404);
    if (gallery.status === 'expired') return res.sendStatus(410);

    const student = gallery.student;
    const photo = await db
      .prepare('SELECT * FROM photos WHERE id = ? AND student_id = ? AND published = 1 AND hidden = 0')
      .get(req.params.id, student.id);
    if (!photo) return res.sendStatus(404);
    if (req.query.download) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${student.last_name}-${student.first_name}-${photo.id}${path.extname(photo.file) || '.jpg'}"`
      );
    }
    return sendPhotoFile(res, photo, req, fullDirectory, thumbDirectory, legacyAssetRoots);
  };
}

module.exports = {
  createStaffPhotoFileHandler,
  createGalleryPhotoFileHandler
};
