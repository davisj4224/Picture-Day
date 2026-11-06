'use strict';

const mail = require('./mail');
const { validProjectGalleryToken } = require('./projects');
const { galleryLink } = require('./gallery');

function validRecipientEmail(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function projectGalleryLink(token, publicUrl) {
  if (!validProjectGalleryToken(token)) throw new Error('Cannot create a project gallery link without a valid token.');
  if (!publicUrl) throw new Error('Set the public gallery URL before creating family links.');
  return `${String(publicUrl).replace(/\/+$/, '')}/p/${encodeURIComponent(token)}`;
}

function resolveProjectEmailRecipients(project, rows, publicUrl, now = Date.now(), requestedIds = null) {
  const requested = requestedIds === null ? null : new Set(requestedIds.map(Number));
  const recipients = [];
  const invalidIds = [];
  for (const row of rows) {
    if (requested && !requested.has(Number(row.student_id))) continue;
    const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
    const available = project && !project.archived_at &&
      row.published_at != null && Number(row.published_at) > 0 &&
      validProjectGalleryToken(row.gallery_token) &&
      (expiresAt === null || expiresAt >= now);
    if (!available || !validRecipientEmail(row.parent_email)) {
      if (requested) invalidIds.push(Number(row.student_id));
      continue;
    }
    recipients.push({
      ...row,
      link: projectGalleryLink(row.gallery_token, publicUrl)
    });
  }
  if (requested) {
    for (const id of requested) {
      if (!rows.some((row) => Number(row.student_id) === id)) invalidIds.push(id);
    }
  }
  return {
    recipients,
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
       s.first_name, s.last_name, s.parent_email
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
  projectGalleryLink,
  resolveProjectEmailRecipients,
  loadProjectEmailContext,
  renderProjectEmail,
  buildProjectExportCsv
};
