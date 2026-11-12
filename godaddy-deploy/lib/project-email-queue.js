'use strict';

const SENDING_LEASE_MS = 120_000;

function isAcceptedHistoricalAttempt(attempt) {
  return attempt.outcome === 'accepted' ||
    (['accepted', 'sent'].includes(attempt.status) && !attempt.outcome);
}

function historicalProjectEmailState(attempts) {
  const accepted = attempts.find(isAcceptedHistoricalAttempt);
  if (accepted) return { status: 'accepted', attempt: accepted };

  const rejected = attempts.find((attempt) => attempt.outcome === 'rejected');
  const unresolved = attempts.find((attempt) =>
    !isAcceptedHistoricalAttempt(attempt) && attempt.outcome !== 'rejected'
  );
  if (unresolved) return { status: 'unresolved', attempt: unresolved };
  if (rejected) return { status: 'failed', attempt: rejected };
  return null;
}

async function updateQueueRecipientFromHistory(tx, queueItemId, email, state) {
  if (!state) return;
  const attempt = state.attempt;
  await tx.prepare(
    `UPDATE project_email_queue_recipients
     SET status = ?, attempted_at = ?, claimed_at = NULL, error_message = ?,
       outcome = ?, diagnostic_json = ?, message_id = ?, attempt_id = ?
     WHERE queue_item_id = ? AND LOWER(recipient_email) = LOWER(?) AND status <> 'sending'`
  ).run(
    state.status,
    attempt.attempted_at,
    attempt.error_message || (state.status === 'unresolved'
      ? 'A previous delivery attempt has no confirmed outcome.'
      : null),
    attempt.outcome || (state.status === 'accepted' ? 'accepted' : 'unknown'),
    attempt.diagnostic_json,
    attempt.message_id,
    attempt.id,
    queueItemId,
    email
  );
}

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

        const history = await tx.prepare(
          `SELECT id, attempted_at, status, error_message, outcome, diagnostic_json, message_id
           FROM gallery_email_attempts
           WHERE project_id = ? AND student_id = ? AND email_type = 'project-gallery'
             AND LOWER(recipient_email) = LOWER(?)
           ORDER BY attempted_at DESC, id DESC`
        ).all(projectId, preview.studentId, email);
        await updateQueueRecipientFromHistory(
          tx,
          item.id,
          email,
          historicalProjectEmailState(history)
        );
      }
    }
  });
  return previews;
}

async function deliverQueueRecipients(recipients, {
  retry = false,
  retryUnresolved = false,
  confirmUnresolved = false,
  claim,
  send,
  record
}) {
  if (retry && retryUnresolved) throw new Error('Choose either a failed or unresolved retry.');
  if (retryUnresolved && !confirmUnresolved) {
    throw new Error('Retrying unresolved deliveries requires explicit confirmation.');
  }
  const eligibleStatuses = retryUnresolved
    ? new Set(['unresolved'])
    : retry
      ? new Set(['failed'])
      : new Set(['queued']);
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
  historicalProjectEmailState,
  persistProjectEmailPreviews,
  deliverQueueRecipients,
  summarizeQueueRecipients
};
