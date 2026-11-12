'use strict';

const SENDING_LEASE_MS = 120_000;

async function persistProjectEmailPreviews(db, projectId, previews, now = Date.now()) {
  await db.transaction(async (tx) => {
    for (const preview of previews) {
      await tx.prepare(
        `INSERT INTO project_email_queue_items
          (project_id, student_id, subject, body, gallery_link, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
         ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body),
           gallery_link = VALUES(gallery_link), status = 'active', updated_at = VALUES(updated_at)`
      ).run(projectId, preview.studentId, preview.subject, preview.text, preview.galleryLink, now, now);
      const item = await tx.prepare(
        'SELECT id FROM project_email_queue_items WHERE project_id = ? AND student_id = ?'
      ).get(projectId, preview.studentId);
      preview.queueItemId = item.id;
      for (const email of preview.recipientEmails) {
        await tx.prepare(
          `INSERT INTO project_email_queue_recipients (queue_item_id, recipient_email, status)
           VALUES (?, ?, 'queued')
           ON DUPLICATE KEY UPDATE recipient_email = VALUES(recipient_email),
             error_message = IF(status = 'excluded', NULL, error_message),
             outcome = IF(status = 'excluded', NULL, outcome),
             status = IF(status = 'excluded', 'queued', status)`
        ).run(item.id, email);
      }
    }
  });
  return previews;
}

async function deliverQueueRecipients(recipients, { retry = false, claim, send, record }) {
  const eligibleStatuses = retry ? new Set(['failed', 'unresolved']) : new Set(['queued']);
  const result = {
    attempted: 0,
    acceptedByGateway: 0,
    failed: 0,
    unresolved: 0,
    excluded: 0,
    errors: []
  };

  for (const recipient of recipients) {
    if (!eligibleStatuses.has(recipient.status)) continue;
    const claimResult = await claim(recipient.id, recipient.status);
    if (!claimResult) continue;
    if (claimResult.excluded) {
      result.excluded++;
      continue;
    }

    result.attempted++;
    try {
      const delivery = await send(recipient);
      await record(recipient, 'accepted', delivery, null);
      result.acceptedByGateway++;
    } catch (error) {
      const status = error.diagnostics?.outcome === 'rejected' ? 'failed' : 'unresolved';
      await record(recipient, status, null, error);
      result[status]++;
      result.errors.push({
        studentId: recipient.student_id,
        recipientEmail: recipient.recipient_email,
        status,
        error: String(error.message || error).slice(0, 300),
        outcome: error.diagnostics?.outcome || 'unknown',
        diagnostics: error.diagnostics || null
      });
    }
  }

  return result;
}

function summarizeQueueRecipients(recipients) {
  return recipients.reduce((summary, recipient) => {
    const status = recipient.status;
    if (Object.hasOwn(summary, status)) summary[status]++;
    return summary;
  }, {
    queued: 0,
    sending: 0,
    accepted: 0,
    failed: 0,
    unresolved: 0,
    excluded: 0
  });
}

module.exports = {
  SENDING_LEASE_MS,
  persistProjectEmailPreviews,
  deliverQueueRecipients,
  summarizeQueueRecipients
};
