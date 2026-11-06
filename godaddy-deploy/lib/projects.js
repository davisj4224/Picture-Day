'use strict';

const crypto = require('node:crypto');
const QR_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  return [...bytes].map((byte) => QR_ALPHABET[byte % QR_ALPHABET.length]).join('');
}

function validProjectGalleryToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(token);
}

function projectQrCode(projectId) {
  return `PD-P${projectId}-${randomCode(12)}`;
}

async function ensureProjectStudent(db, projectId, studentId) {
  const project = await db.prepare('SELECT id, archived_at FROM projects WHERE id = ?').get(projectId);
  if (!project) return { status: 'not-found' };
  if (project.archived_at) return { status: 'archived' };
  const student = await db.prepare('SELECT id FROM students WHERE id = ?').get(studentId);
  if (!student) return { status: 'student-not-found' };
  await db.prepare(
    `INSERT INTO project_students (project_id, student_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE student_id = VALUES(student_id)`
  ).run(projectId, studentId);
  return { status: 'ready' };
}

async function projectStudentQrCode(db, projectId, studentId) {
  const ensured = await ensureProjectStudent(db, projectId, studentId);
  if (ensured.status !== 'ready') return ensured;
  const existing = await db.prepare(
    'SELECT qr_code FROM project_students WHERE project_id = ? AND student_id = ?'
  ).get(projectId, studentId);
  if (existing?.qr_code) return { status: 'ready', qrCode: existing.qr_code };

  for (let attempt = 0; attempt < 10; attempt++) {
    const qrCode = projectQrCode(projectId);
    try {
      const legacyCode = await db.prepare('SELECT 1 FROM students WHERE qr_code = ?').get(qrCode);
      if (legacyCode) continue;
      await db.prepare(
        'UPDATE project_students SET qr_code = ? WHERE project_id = ? AND student_id = ? AND qr_code IS NULL'
      ).run(qrCode, projectId, studentId);
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
      continue;
    }
    const saved = await db.prepare(
      'SELECT qr_code FROM project_students WHERE project_id = ? AND student_id = ?'
    ).get(projectId, studentId);
    if (saved?.qr_code) return { status: 'ready', qrCode: saved.qr_code };
  }
  throw new Error('Could not generate a unique project QR code.');
}

function resolveProjectQr(normalizedCode, projectCodes, studentCodes) {
  if (!normalizedCode) return null;
  if (projectCodes.has(normalizedCode)) {
    return { studentId: projectCodes.get(normalizedCode), source: 'project' };
  }
  if (studentCodes.has(normalizedCode)) {
    return { studentId: studentCodes.get(normalizedCode), source: 'legacy' };
  }
  return null;
}

async function publishProjectStudent(db, projectId, studentId, galleryDays, newGalleryToken) {
  return db.transaction(async (tx) => {
    const project = await tx.prepare(
      'SELECT id, archived_at FROM projects WHERE id = ? FOR UPDATE'
    ).get(projectId);
    if (!project) return { status: 'not-found' };
    if (project.archived_at) return { status: 'archived' };

    const ensured = await ensureProjectStudent(tx, projectId, studentId);
    if (ensured.status !== 'ready') return ensured;
    const row = await tx.prepare(
      'SELECT gallery_token FROM project_students WHERE project_id = ? AND student_id = ?'
    ).get(projectId, studentId);
    const reused = validProjectGalleryToken(row.gallery_token);
    const token = reused ? row.gallery_token : newGalleryToken();
    if (!validProjectGalleryToken(token)) throw new Error('Could not generate a valid project gallery token.');
    const publishedAt = Date.now();
    const expiresAt = publishedAt + Number(galleryDays) * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(expiresAt) || expiresAt <= publishedAt) {
      throw new Error('Project gallery expiration could not be calculated.');
    }

    await tx.prepare(
      `UPDATE project_students
       SET gallery_token = ?, expires_at = ?, published_at = ?, republish_required = 0
       WHERE project_id = ? AND student_id = ?`
    ).run(token, expiresAt, publishedAt, projectId, studentId);
    const persisted = await tx.prepare(
      `SELECT gallery_token, expires_at, published_at, republish_required FROM project_students
       WHERE project_id = ? AND student_id = ?`
    ).get(projectId, studentId);
    if (
      persisted?.gallery_token !== token ||
      Number(persisted.published_at) !== publishedAt ||
      Number(persisted.expires_at) !== expiresAt ||
      Number(persisted.republish_required) !== 0
    ) {
      throw new Error('Project gallery publication was not persisted.');
    }
    await tx.prepare(
      `UPDATE photos SET published = 1
       WHERE project_id = ? AND student_id = ? AND is_marker = 0 AND hidden = 0`
    ).run(projectId, studentId);
    return { status: 'published', ...persisted, token, reused };
  });
}

async function unpublishProjectStudent(db, projectId, studentId) {
  await db.prepare(
    'UPDATE project_students SET published_at = NULL WHERE project_id = ? AND student_id = ?'
  ).run(projectId, studentId);
  await db.prepare(
    'UPDATE photos SET published = 0 WHERE project_id = ? AND student_id = ?'
  ).run(projectId, studentId);
}

async function archiveProject(db, projectId, archivedAt = Date.now()) {
  return db.transaction(async (tx) => {
    const project = await tx.prepare(
      'SELECT id FROM projects WHERE id = ? FOR UPDATE'
    ).get(projectId);
    if (!project) return { status: 'not-found' };
    await tx.prepare(
      'UPDATE projects SET archived_at = COALESCE(archived_at, ?) WHERE id = ?'
    ).run(archivedAt, projectId);
    await tx.prepare(
      'UPDATE project_students SET republish_required = 1 WHERE project_id = ?'
    ).run(projectId);
    return { status: 'archived' };
  });
}

async function unarchiveProject(db, projectId) {
  return db.transaction(async (tx) => {
    const project = await tx.prepare(
      'SELECT id FROM projects WHERE id = ? FOR UPDATE'
    ).get(projectId);
    if (!project) return { status: 'not-found' };
    await tx.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(projectId);
    return { status: 'unarchived' };
  });
}

async function projectGalleryStudentByToken(db, token, now = Date.now()) {
  const row = await db.prepare(
    `SELECT ps.project_id, ps.student_id, ps.gallery_token, ps.expires_at, ps.published_at,
       ps.republish_required,
       p.name AS project_name, p.archived_at, s.first_name, s.last_name, s.grade, s.teacher
     FROM project_students ps
     JOIN projects p ON p.id = ps.project_id
     JOIN students s ON s.id = ps.student_id
     WHERE ps.gallery_token = ?`
  ).get(token);
  if (!row || !row.published_at || row.archived_at || row.republish_required) {
    return { student: null, status: 'not-found' };
  }
  if (row.expires_at && Number(row.expires_at) < now) return { student: null, status: 'expired' };
  return { student: row, status: 'published' };
}

async function projectGalleryPhotos(db, projectId, studentId) {
  return db.prepare(
    `SELECT id, captured_at FROM photos
     WHERE project_id = ? AND student_id = ? AND published = 1 AND hidden = 0 AND is_marker = 0
     ORDER BY COALESCE(captured_at, 0), seq_index, id`
  ).all(projectId, studentId);
}

function newProjectGalleryToken() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = {
  ensureProjectStudent,
  projectStudentQrCode,
  resolveProjectQr,
  archiveProject,
  unarchiveProject,
  publishProjectStudent,
  unpublishProjectStudent,
  projectGalleryStudentByToken,
  projectGalleryPhotos,
  validProjectGalleryToken,
  newProjectGalleryToken
};
