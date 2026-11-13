'use strict';

const {
  validGalleryToken,
  galleryLink: buildLegacyGalleryLink
} = require('./gallery');
const { validProjectGalleryToken } = require('./projects');

function parseEmailProjectId(value) {
  if (value === undefined || value === null || value === '' || value === 'legacy') return null;
  const projectId = Number(value);
  return Number.isSafeInteger(projectId) && projectId > 0 ? projectId : undefined;
}

async function loadEmailRows(db, projectId, { pendingOnly = true, now = Date.now() } = {}) {
  if (projectId === null) {
    const sentFilter = pendingOnly
      ? `AND NOT EXISTS (
           SELECT 1 FROM email_log e WHERE e.student_id = s.id AND e.status = 'sent'
         )`
      : '';
    return db.prepare(
      `SELECT s.*
       FROM students s
       WHERE s.published_at IS NOT NULL
         AND s.parent_email IS NOT NULL AND s.parent_email <> ''
         AND s.gallery_token IS NOT NULL AND s.gallery_token <> ''
         AND EXISTS (
           SELECT 1 FROM photos ph
           WHERE ph.student_id = s.id AND ph.project_id IS NULL
             AND ph.published = 1 AND ph.is_marker = 0 AND ph.hidden = 0
         )
         ${sentFilter}
       ORDER BY s.last_name, s.first_name`
    ).all();
  }

  const project = await db.prepare(
    'SELECT id, name, archived_at FROM projects WHERE id = ?'
  ).get(projectId);
  if (!project) return null;

  const sentFilter = pendingOnly
    ? `AND NOT EXISTS (
         SELECT 1 FROM gallery_email_attempts a
         WHERE a.project_id = ps.project_id AND a.student_id = s.id
           AND a.email_type = 'project-gallery'
           AND (a.status IN ('accepted', 'sent') OR a.outcome = 'accepted')
       )`
    : '';
  const rows = await db.prepare(
    `SELECT s.*, ps.gallery_token AS project_gallery_token,
       ps.expires_at AS project_expires_at, ps.published_at AS project_published_at,
       ps.republish_required, p.name AS project_name
     FROM project_students ps
     JOIN projects p ON p.id = ps.project_id
     JOIN students s ON s.id = ps.student_id
     WHERE ps.project_id = ? AND p.archived_at IS NULL AND s.active = 1
       AND ps.published_at IS NOT NULL AND ps.republish_required = 0
       AND ps.gallery_token IS NOT NULL AND ps.gallery_token <> ''
       AND (ps.expires_at IS NULL OR ps.expires_at >= ?)
       AND s.parent_email IS NOT NULL AND s.parent_email <> ''
       AND EXISTS (
         SELECT 1 FROM photos ph
         WHERE ph.project_id = ps.project_id AND ph.student_id = s.id
           AND ph.published = 1 AND ph.hidden = 0 AND ph.is_marker = 0
       )
       ${sentFilter}
     ORDER BY s.last_name, s.first_name`
  ).all(projectId, now);

  return rows.filter((row) => validProjectGalleryToken(row.project_gallery_token));
}

async function loadEmailStudent(db, projectId, studentId, now = Date.now()) {
  if (projectId === null) {
    const student = await db.prepare(
      `SELECT s.* FROM students s
       WHERE s.id = ? AND s.published_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM photos ph
           WHERE ph.student_id = s.id AND ph.project_id IS NULL
             AND ph.published = 1 AND ph.is_marker = 0 AND ph.hidden = 0
         )`
    ).get(studentId);
    if (!student || !validGalleryToken(student.gallery_token)) return null;
    if (student.expires_at && Number(student.expires_at) < now) return null;
    return student;
  }

  const student = await db.prepare(
    `SELECT s.*, ps.gallery_token AS project_gallery_token,
       ps.expires_at AS project_expires_at, ps.published_at AS project_published_at,
       ps.republish_required, p.name AS project_name
     FROM project_students ps
     JOIN projects p ON p.id = ps.project_id
     JOIN students s ON s.id = ps.student_id
     WHERE ps.project_id = ? AND ps.student_id = ? AND p.archived_at IS NULL
       AND s.active = 1 AND ps.published_at IS NOT NULL AND ps.republish_required = 0
       AND (ps.expires_at IS NULL OR ps.expires_at >= ?)
       AND EXISTS (
         SELECT 1 FROM photos ph
         WHERE ph.project_id = ps.project_id AND ph.student_id = s.id
           AND ph.published = 1 AND ph.hidden = 0 AND ph.is_marker = 0
       )`
  ).get(projectId, studentId, now);
  if (!student || !validProjectGalleryToken(student.project_gallery_token)) return null;
  return student;
}

function emailGalleryLink(student, projectId, publicUrl) {
  const token = projectId === null ? student.gallery_token : student.project_gallery_token;
  if (projectId === null) return buildLegacyGalleryLink(token, publicUrl);
  if (!validProjectGalleryToken(token)) throw new Error('Cannot create an email link without a valid gallery token.');
  if (!publicUrl) throw new Error('Set the public gallery URL before creating family links.');
  const prefix = projectId === null ? '/g/' : '/p/';
  return `${String(publicUrl).replace(/\/+$/, '')}${prefix}${encodeURIComponent(token)}`;
}

function emailTemplateVariables(student, projectId, branding, publicUrl) {
  return {
    student: `${student.first_name} ${student.last_name}`,
    first: student.first_name,
    school: branding.schoolName,
    event: projectId === null ? branding.eventName : student.project_name,
    year: branding.year,
    link: emailGalleryLink(student, projectId, publicUrl),
    expires: (projectId === null ? student.expires_at : student.project_expires_at)
      ? new Date(Number(projectId === null ? student.expires_at : student.project_expires_at)).toLocaleDateString()
      : ''
  };
}

module.exports = {
  parseEmailProjectId,
  loadEmailRows,
  loadEmailStudent,
  emailGalleryLink,
  emailTemplateVariables
};
