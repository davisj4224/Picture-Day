'use strict';

const { SENDING_LEASE_MS } = require('./project-email-queue');
const {
  loadProjectEmailContext,
  parseProjectEmailAddresses,
  projectEmailExclusionReason,
  renderProjectEmail
} = require('./project-email');

async function claimProjectEmailAttempt(db, projectId, studentId, recipientEmail, now) {
  return db.transaction(async (tx) => {
    const project = await tx.prepare(
      'SELECT id, name, archived_at FROM projects WHERE id = ? FOR UPDATE'
    ).get(projectId);
    if (!project || project.archived_at) return null;

    const student = await tx.prepare(
      `SELECT ps.student_id, ps.gallery_token, ps.expires_at, ps.published_at,
         ps.republish_required, s.first_name, s.last_name, s.parent_email, s.active
       FROM project_students ps
       JOIN students s ON s.id = ps.student_id
       WHERE ps.project_id = ? AND ps.student_id = ? FOR UPDATE`
    ).get(projectId, studentId);
    if (!student || projectEmailExclusionReason(project, student, now)) return null;

    const currentEmails = parseProjectEmailAddresses(student.parent_email).valid;
    if (!currentEmails.some((email) => email.toLowerCase() === recipientEmail.toLowerCase())) return null;

    const history = await tx.prepare(
      `SELECT id, attempted_at, status, outcome, error_message, diagnostic_json, message_id
       FROM gallery_email_attempts
       WHERE project_id = ? AND student_id = ? AND email_type = 'project-gallery'
         AND LOWER(recipient_email) = LOWER(?)
       ORDER BY attempted_at DESC, id DESC
       FOR UPDATE`
    ).all(projectId, studentId, recipientEmail);
    const activeAttempt = history.find((attempt) =>
      attempt.status === 'pending' && Number(attempt.attempted_at) >= now - SENDING_LEASE_MS
    );
    if (activeAttempt) return null;

    const attempt = await tx.prepare(
      `INSERT INTO gallery_email_attempts
        (student_id, project_id, recipient_email, email_type, attempted_at, status)
       VALUES (?, ?, ?, 'project-gallery', ?, 'pending')`
    ).run(studentId, projectId, recipientEmail, now);

    return { attemptId: attempt.lastInsertRowid, project, student };
  });
}

async function recordProjectEmailAttempt(db, attemptId, status, outcome, diagnostics, messageId, error) {
  const result = await db.prepare(
    `UPDATE gallery_email_attempts
     SET status = ?, error_message = ?, outcome = ?, diagnostic_json = ?, message_id = ?
     WHERE id = ? AND email_type = 'project-gallery'`
  ).run(
    status,
    error ? String(error.message || error).slice(0, 300) : null,
    outcome,
    diagnostics ? JSON.stringify(diagnostics) : null,
    messageId || null,
    attemptId
  );
  if (result.changes !== 1) throw new Error('Project email attempt result was not persisted.');
}

async function sendProjectEmailRecipients({
  db,
  projectId,
  studentIds,
  publicUrl,
  emailConfig,
  branding,
  mailer,
  now = Date.now
}) {
  const context = await loadProjectEmailContext(db, projectId, publicUrl, now(), studentIds);
  if (!context) return { status: 'not-found' };
  if (context.project.archived_at) return { status: 'archived', projectName: context.project.name };

  const result = {
    status: 'sent',
    projectName: context.project.name,
    attempted: 0,
    acceptedByGateway: 0,
    failed: 0,
    unresolved: 0,
    skipped: 0,
    excluded: context.excluded.length,
    errors: []
  };

  for (const student of context.recipients) {
    for (const recipientEmail of student.recipientEmails) {
      const claim = await claimProjectEmailAttempt(db, projectId, student.student_id, recipientEmail, now());
      if (!claim) {
        result.skipped++;
        continue;
      }

      const rendered = renderProjectEmail(claim.project, claim.student, emailConfig, branding, publicUrl);
      result.attempted++;
      try {
        const delivery = await mailer.send({
          to: recipientEmail,
          subject: rendered.subject,
          text: rendered.text,
          link: rendered.link,
          replyTo: emailConfig.emailReplyTo,
          palette: branding.palette
        });
        await recordProjectEmailAttempt(
          db,
          claim.attemptId,
          'accepted',
          delivery.outcome || 'accepted',
          delivery.diagnostics || null,
          delivery.messageId,
          null
        );
        result.acceptedByGateway++;
      } catch (error) {
        const outcome = error.diagnostics?.outcome || 'unknown';
        const status = outcome === 'rejected' ? 'failed' : 'unresolved';
        await recordProjectEmailAttempt(
          db,
          claim.attemptId,
          status,
          outcome,
          error.diagnostics || null,
          null,
          error
        );
        result[status]++;
        result.errors.push({
          studentId: student.student_id,
          status,
          error: String(error.message || error).slice(0, 300)
        });
      }
    }
  }

  return result;
}

module.exports = {
  sendProjectEmailRecipients
};
