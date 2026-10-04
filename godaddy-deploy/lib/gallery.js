'use strict';

function validGalleryToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token);
}

async function publishStudentRecord(db, id, galleryDays, newGalleryToken, logger = console) {
  const student = await db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  if (!student) return null;

  const reusedToken = validGalleryToken(student.gallery_token);
  const token = reusedToken ? student.gallery_token : newGalleryToken();
  if (!validGalleryToken(token)) throw new Error('Could not generate a valid gallery token.');
  const publishedAt = Date.now();
  const expiresAt = publishedAt + Number(galleryDays) * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= publishedAt) {
    throw new Error('Gallery expiration could not be calculated.');
  }

  const update = await db.prepare(
    'UPDATE students SET gallery_token=?, expires_at=?, published_at=? WHERE id=?'
  ).run(token, expiresAt, publishedAt, id);
  const refreshed = await db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  const tokenPersisted = Boolean(refreshed && refreshed.gallery_token === token);
  const publishedPersisted = Boolean(refreshed && Number(refreshed.published_at) === publishedAt);
  const expiresPersisted = Boolean(refreshed && Number(refreshed.expires_at) === expiresAt);

  logger.info('Gallery publish persistence check', {
    studentId: id,
    tokenAction: reusedToken ? 'reused' : 'generated',
    affectedRows: update.changes,
    expectedRowAffected: update.changes === 1,
    tokenPersisted,
    publishedPersisted,
    expiresPersisted
  });

  if (!tokenPersisted || !publishedPersisted || !expiresPersisted) {
    throw new Error('Gallery publish was not persisted to MySQL; no gallery email should be sent.');
  }

  return refreshed;
}

async function galleryStudentByToken(db, token, now = Date.now()) {
  const student = await db.prepare('SELECT * FROM students WHERE gallery_token = ?').get(token);
  if (!student || !student.published_at) return { student: null, status: 'not-found' };
  if (student.expires_at && Number(student.expires_at) < now) {
    return { student: null, status: 'expired' };
  }
  return { student, status: 'published' };
}

async function galleryStudentForEmail(db, id, now = Date.now()) {
  const student = await db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  if (!student || !student.published_at || !validGalleryToken(student.gallery_token)) {
    const error = new Error('Gallery is not published; no email was sent.');
    error.code = 'GALLERY_NOT_PUBLISHED';
    throw error;
  }
  if (student.expires_at && Number(student.expires_at) < now) {
    const error = new Error('Gallery has expired; no email was sent.');
    error.code = 'GALLERY_EXPIRED';
    throw error;
  }
  return student;
}

function galleryLink(token, publicUrl) {
  if (!validGalleryToken(token)) throw new Error('Cannot create a gallery link without a valid persisted token.');
  if (!publicUrl) throw new Error('Set the public gallery URL before creating family links.');
  const base = String(publicUrl).replace(/\/+$/, '');
  return `${base}/g/${encodeURIComponent(token)}`;
}

module.exports = {
  publishStudentRecord,
  galleryStudentByToken,
  galleryStudentForEmail,
  galleryLink
};
