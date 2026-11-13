'use strict';

const {
  parseProjectEmailAddresses,
  projectEmailExclusionReason
} = require('./project-email');

async function loadProjectGalleryEmailContext(db, projectId, studentId, now = Date.now()) {
  const project = await db.prepare(
    'SELECT id, name, archived_at FROM projects WHERE id = ?'
  ).get(projectId);
  if (!project) return null;

  const student = await db.prepare(
    `SELECT ps.student_id, ps.gallery_token, ps.expires_at, ps.published_at,
       ps.republish_required, s.parent_email, s.active
     FROM project_students ps
     JOIN students s ON s.id = ps.student_id
     WHERE ps.project_id = ? AND ps.student_id = ?`
  ).get(projectId, studentId);
  if (!student) return null;

  return {
    project,
    student,
    reason: projectEmailExclusionReason(project, student, now)
  };
}

async function loadProjectGalleryEmailHistory(db, projectId, studentId, now = Date.now()) {
  const context = await loadProjectGalleryEmailContext(db, projectId, studentId, now);
  if (!context) return null;

  const attempts = await db.prepare(
    `SELECT id, recipient_email, attempted_at, status, error_message,
       outcome, diagnostic_json
     FROM gallery_email_attempts
     WHERE project_id = ? AND student_id = ? AND email_type = 'project-gallery'
     ORDER BY attempted_at DESC, id DESC LIMIT 25`
  ).all(projectId, studentId);

  const addresses = parseProjectEmailAddresses(context.student.parent_email);
  const redactToken = (value) => typeof value === 'string' && context.student.gallery_token
    ? value.split(context.student.gallery_token).join('[redacted]')
    : value;
  return {
    eligible: !context.reason,
    reason: context.reason,
    published: context.student.published_at != null && Number(context.student.published_at) > 0,
    recipientEmail: String(context.student.parent_email || '').trim(),
    hasValidRecipient: addresses.valid.length > 0,
    attempts: attempts.map((attempt) => ({
      ...attempt,
      error_message: redactToken(attempt.error_message),
      diagnostic_json: redactToken(attempt.diagnostic_json)
    }))
  };
}

module.exports = {
  loadProjectGalleryEmailContext,
  loadProjectGalleryEmailHistory
};
