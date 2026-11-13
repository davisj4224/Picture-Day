'use strict';

const mail = require('./mail');
const { validProjectGalleryToken } = require('./projects');
const { galleryLink } = require('./gallery');

function validRecipientEmail(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseProjectEmailAddresses(value) {
  const seen = new Set();
  const addresses = String(value || '').split(/[;,\s]+/).map((part) => part.trim()).filter((address) => {
    const key = address.toLowerCase();
    if (!address || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    valid: addresses.filter(validRecipientEmail),
    invalid: addresses.filter((address) => !validRecipientEmail(address))
  };
}

function projectGalleryLink(token, publicUrl) {
  if (!validProjectGalleryToken(token)) throw new Error('Cannot create a project gallery link without a valid token.');
  if (!publicUrl) throw new Error('Set the public gallery URL before creating family links.');
  return `${String(publicUrl).replace(/\/+$/, '')}/p/${encodeURIComponent(token)}`;
}

function projectEmailExclusionReason(project, row, now) {
  if (!project || project.archived_at) return 'Project is archived.';
  if (Number(row.active) !== 1) return 'Student is inactive.';
  if (row.republish_required) return 'Gallery needs republishing.';
  if (row.published_at == null || Number(row.published_at) <= 0) return 'Gallery is unpublished.';
  if (!validProjectGalleryToken(row.gallery_token)) return 'Gallery link is invalid.';
  const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
  if (expiresAt !== null && expiresAt < now) return 'Gallery has expired.';
  const addresses = parseProjectEmailAddresses(row.parent_email);
  if (!addresses.valid.length) {
    return addresses.invalid.length
      ? 'No valid parent/guardian email address is on file.'
      : 'No parent/guardian email address is on file.';
  }
  return null;
}

function projectEmailDeliveryStatus(attempts) {
  const latest = attempts[0];
  if (!latest) return 'not-sent';
  if (latest.outcome === 'accepted' || latest.status === 'accepted' || latest.status === 'sent') return 'sent';
  if (latest.outcome === 'rejected' || latest.status === 'failed') return 'failed';
  return 'not-sent';
}

function resolveProjectEmailRecipients(project, rows, publicUrl, now = Date.now(), requestedIds = null) {
  const requested = requestedIds === null ? null : new Set(requestedIds.map(Number));
  const recipients = [];
  const excluded = [];
  const invalidIds = [];
  for (const row of rows) {
    if (requested && !requested.has(Number(row.student_id))) continue;
    const reason = projectEmailExclusionReason(project, row, now);
    if (reason) {
      excluded.push({
        ...row,
        reason
      });
      if (requested) invalidIds.push(Number(row.student_id));
      continue;
    }
    const addresses = parseProjectEmailAddresses(row.parent_email);
    recipients.push({
      ...row,
      recipientEmails: addresses.valid,
      invalidEmails: addresses.invalid,
      link: projectGalleryLink(row.gallery_token, publicUrl)
    });
  }
  if (requested) {
    for (const id of requested) {
      if (!rows.some((row) => Number(row.student_id) === id)) {
        invalidIds.push(id);
        excluded.push({ student_id: id, reason: 'Student is not assigned to this project.' });
      }
    }
  }
  return {
    recipients,
    excluded,
    invalidIds: [...new Set(invalidIds)]
  };
}

async function loadProjectEmailContext(db, projectId, publicUrl, now = Date.now(), requestedIds = null) {
  const project = await db.prepare(
    'SELECT id, name, archived_at FROM projects WHERE id = ?'
  ).get(projectId);
  if (!project) return null;
  const rows = await db.prepare(
    `SELECT ps.student_id, ps.gallery_token, ps.expires_at, ps.published_at,
       ps.republish_required,
       s.first_name, s.last_name, s.parent_email, s.active
     FROM project_students ps
     JOIN students s ON s.id = ps.student_id
     WHERE ps.project_id = ?
     ORDER BY s.last_name, s.first_name`
  ).all(projectId);
  return {
    project,
    rows,
    ...resolveProjectEmailRecipients(project, rows, publicUrl, now, requestedIds)
  };
}

function renderProjectEmail(project, student, cfg, branding, publicUrl) {
  const link = projectGalleryLink(student.gallery_token, publicUrl);
  const vars = {
    student: `${student.first_name} ${student.last_name}`,
    first: student.first_name,
    school: branding.schoolName,
    event: project.name,
    year: branding.year,
    link,
    expires: student.expires_at ? new Date(Number(student.expires_at)).toLocaleDateString() : ''
  };
  let text = mail.render(cfg.emailBody, vars);
  if (!text.includes(vars.student)) text = `Photos for ${vars.student}\n\n${text}`;
  if (!text.includes(project.name)) text = `Photo shoot project: ${project.name}\n\n${text}`;
  if (!text.includes(link)) text = `${text.trimEnd()}\n\n${link}`;
  let subject = mail.render(cfg.emailSubject, vars);
  if (!subject.includes(project.name)) subject = `${subject} — ${project.name}`;
  return {
    link,
    subject,
    text
  };
}

function buildProjectEmailPreviews(project, recipients, cfg, branding, publicUrl) {
  return recipients.map((student) => {
    const rendered = renderProjectEmail(project, student, cfg, branding, publicUrl);
    return {
      studentId: student.student_id,
      student: `${student.first_name} ${student.last_name}`,
      recipientEmails: student.recipientEmails,
      invalidEmails: student.invalidEmails,
      subject: rendered.subject,
      text: rendered.text,
      galleryLink: rendered.link
    };
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[\u0000-\u0020]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

function buildProjectExportCsv(students, project, memberships, publicUrl, now = Date.now()) {
  const lines = [[
    'Student', 'Grade', 'Teacher', 'Parent email', 'Gallery link', 'Expires', 'Gallery status',
    'Photo shoot project', 'Project gallery link'
  ].map(csvCell).join(',')];
  for (const student of students) {
    const membership = memberships.get(Number(student.id));
    const available = project && !project.archived_at && membership &&
      !membership.republish_required &&
      membership.published_at != null && Number(membership.published_at) > 0 &&
      validProjectGalleryToken(membership.gallery_token) &&
      (membership.expires_at == null || Number(membership.expires_at) >= now);
    lines.push([
      `${student.first_name} ${student.last_name}`,
      student.grade,
      student.teacher,
      student.parent_email,
      student.published_at && student.gallery_token ? galleryLink(student.gallery_token, publicUrl) : '',
      student.published_at && student.expires_at ? new Date(Number(student.expires_at)).toLocaleDateString() : '',
      student.published_at ? 'Published' : 'Not published',
      project?.name || '',
      available ? projectGalleryLink(membership.gallery_token, publicUrl) : ''
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

module.exports = {
  validRecipientEmail,
  parseProjectEmailAddresses,
  projectEmailExclusionReason,
  projectEmailDeliveryStatus,
  projectGalleryLink,
  resolveProjectEmailRecipients,
  loadProjectEmailContext,
  renderProjectEmail,
  buildProjectEmailPreviews,
  buildProjectExportCsv
};
