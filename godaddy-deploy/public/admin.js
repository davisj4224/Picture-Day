import { $, $$, api, session, toast, esc, fmtDate } from '/assets/common.js';
import { scan, ready as readerReady } from '/assets/qr-scan.js';

const LEGACY_GALLERY_NAME = 'Original Picture Day (Existing Photos)';

const state = {
  students: [],
  projects: [],
  projectStudents: [],
  activeProject: null,
  legacyGalleryMode: false,
  stats: null,
  config: {},
  branding: null,
  gallery: null,
  selected: new Set()
};

function galleryUrl(token) {
  const base = String(state.config.publicUrl || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/g/${encodeURIComponent(token)}`;
}

function projectGalleryUrl(token) {
  const base = String(state.config.publicUrl || '').replace(/\/+$/, '');
  return base && token ? `${base}/p/${encodeURIComponent(token)}` : '';
}

/* ------------------------------------------------------------- startup */

const me = await session();
if (!me.user || !['staff', 'admin'].includes(me.user.role)) location.href = '/login';
if (me.user.role !== 'admin') $('#staffAccountsCard').hidden = true;
$('#createProjectCard').hidden = me.user.role !== 'admin';
$('#who').textContent = `Signed in as ${me.user.username}`;
state.config = me.config || {};

state.branding = await api('/api/branding');
$('#railSchool').textContent = state.branding.schoolName;
$('#railYear').textContent = `${state.branding.eventName} ${state.branding.year}`;

$('#signout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/login';
});

/* ------------------------------------------------------------------ nav */

function show(view) {
  $$('#nav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === view)));
  $$('.view').forEach((s) => s.classList.toggle('on', s.id === `view-${view}`));
  location.hash = view;
  if (view === 'review') loadReview();
  if (view === 'email') loadPending();
  if (view === 'upload') loadBatches();
  if (view === 'floor') loadStats();
  if (view === 'settings' && me.user.role === 'admin') loadStaffAccounts();
  if (view === 'projects') loadProjects();
}
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) show(b.dataset.view);
});

/* ------------------------------------------------------------- projects */

function isProjectWritable(project = state.activeProject) {
  return Boolean(project && !project.archived_at);
}

function renderProjectContext() {
  const project = state.activeProject;
  const status = state.legacyGalleryMode
    ? `${LEGACY_GALLERY_NAME} is selected. Select a photo-shoot project before uploading.`
    : !project
      ? 'No photo collection selected. Uploading is disabled.'
    : project.archived_at
      ? `${project.name} is archived. Public galleries are inaccessible; unarchive and explicitly republish to restore access.`
      : `Selected project: ${project.name}`;
  const collectionName = project?.name ||
    (state.legacyGalleryMode ? LEGACY_GALLERY_NAME : 'No photo collection selected');
  $('#activeProjectStatus').textContent = status;
  $('#uploadProjectStatus').textContent = status;
  $('#reviewProjectName').textContent = collectionName;
  $('#files').disabled = !isProjectWritable();
  $('#startUpload').disabled = busy || queuedFiles.length === 0 || !isProjectWritable();
  $('#printProjectCards').disabled = !isProjectWritable();
  $('#publishProjectReady').hidden = !project || Boolean(project.archived_at);
  $('#galleryStudent').hidden = Boolean(project);
  $('#projectGalleryStudent').hidden = !project;
  $('#publishReady').hidden = Boolean(project);
  $('#galleryEmailHistory').hidden = Boolean(project) || !state.gallery;
  $('#resendGalleryEmail').hidden = Boolean(project);
}

async function loadProjects() {
  const previous = localStorage.getItem('pictureday.activeProject') ||
    (state.activeProject ? String(state.activeProject.id) : 'legacy');
  state.projects = await api('/api/projects');
  const options = '<option value="">Choose a photo collection…</option>' +
    `<option value="legacy">${LEGACY_GALLERY_NAME}</option>` +
    state.projects.map((project) =>
      `<option value="${project.id}">${esc(project.name)}${project.archived_at ? ' — archived' : ''}</option>`
    ).join('');
  const selectValue = previous === 'legacy' || !state.projects.some((project) => String(project.id) === previous)
    ? 'legacy'
    : previous;
  state.activeProject = state.projects.find((project) => String(project.id) === selectValue) || null;
  state.legacyGalleryMode = selectValue === 'legacy';
  for (const select of [$('#activeProject'), $('#galleryProject')]) {
    select.innerHTML = options;
    select.value = selectValue;
  }
  localStorage.setItem('pictureday.activeProject', selectValue);
  $('#projectTable tbody').innerHTML = `<tr>
        <td><b>${LEGACY_GALLERY_NAME}</b></td>
        <td>Existing photos</td>
        <td><span class="pill live">Available</span></td>
        <td style="white-space:nowrap"><button class="ghost small" data-select-project="legacy">Select</button></td>
      </tr>` + (state.projects.length
    ? state.projects.map((project) => `<tr>
        <td><b>${esc(project.name)}</b></td>
        <td>${fmtDate(project.created_at)}</td>
        <td>${project.archived_at ? '<span class="pill none">Archived</span>' : '<span class="pill live">Active</span>'}</td>
        <td style="white-space:nowrap">
          <button class="ghost small" data-select-project="${project.id}">Select</button>
          ${me.user.role === 'admin' && !project.archived_at
            ? `<button class="ghost small danger" data-archive-project="${project.id}">Archive</button>`
            : me.user.role === 'admin'
              ? `<button class="ghost small" data-unarchive-project="${project.id}">Unarchive</button>`
            : ''}
        </td>
      </tr>`).join('')
    : '');
  renderProjectContext();
  await loadProjectStudents();
}

async function selectProject(id) {
  state.activeProject = id && id !== 'legacy'
    ? state.projects.find((project) => project.id === Number(id)) || null
    : null;
  state.legacyGalleryMode = id === 'legacy';
  if (state.activeProject || state.legacyGalleryMode) localStorage.setItem('pictureday.activeProject', state.legacyGalleryMode ? 'legacy' : String(state.activeProject.id));
  else localStorage.removeItem('pictureday.activeProject');
  $('#activeProject').value = state.legacyGalleryMode ? 'legacy' : state.activeProject ? String(state.activeProject.id) : '';
  $('#galleryProject').value = $('#activeProject').value;
  clearGallery();
  renderProjectContext();
  await loadProjectStudents();
  await Promise.all([loadBatches(), loadReview()]);
}

for (const selector of [$('#activeProject'), $('#galleryProject')]) {
  selector.addEventListener('change', () => selectProject(selector.value));
}

$('#createProject').addEventListener('click', async () => {
  const name = $('#newProjectName').value.trim();
  if (!name) return toast('Enter a project name.', 'bad');
  try {
    const project = await api('/api/projects', { method: 'POST', body: { name } });
    $('#newProjectName').value = '';
    await loadProjects();
    await selectProject(project.id);
    toast(`${project.name} created.`, 'good');
  } catch (error) {
    toast(error.message, 'bad');
  }
});

$('#projectTable').addEventListener('click', async (event) => {
  const selectButton = event.target.closest('button[data-select-project]');
  if (selectButton) {
    await selectProject(selectButton.dataset.selectProject);
    return;
  }
  const archiveButton = event.target.closest('button[data-archive-project]');
  const unarchiveButton = event.target.closest('button[data-unarchive-project]');
  const projectId = Number(archiveButton?.dataset.archiveProject || unarchiveButton?.dataset.unarchiveProject);
  if (!projectId) return;
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  if (archiveButton && !confirm(`Archive “${project.name}”? Public galleries will close until you unarchive and explicitly republish them. Project records and links are retained.`)) return;
  if (unarchiveButton && !confirm(`Unarchive “${project.name}”? Public galleries will remain inaccessible until explicitly republished.`)) return;
  try {
    await api(`/api/projects/${project.id}/${archiveButton ? 'archive' : 'unarchive'}`, { method: 'POST' });
    await loadProjects();
    toast(archiveButton
      ? `${project.name} archived. Public galleries are inaccessible.`
      : `${project.name} unarchived. Explicitly republish galleries to restore access.`, 'good');
  } catch (error) {
    toast(error.message, 'bad');
  }
});

async function loadProjectStudents() {
  const project = state.activeProject;
  state.projectStudents = project ? await api(`/api/projects/${project.id}/students`) : [];
  if (!project) {
    const select = $('#galleryStudent');
    const keep = select.value;
    const legacyStudents = state.students.filter((student) => Number(student.photoCount) > 0);
    select.innerHTML = '<option value="">Choose a student…</option>' +
      legacyStudents.map((student) =>
        `<option value="${student.id}">${esc(student.lastName)}, ${esc(student.firstName)}${student.grade ? ` (${esc(student.grade)})` : ''}</option>`
      ).join('');
    select.value = legacyStudents.some((student) => String(student.id) === keep) ? keep : '';
    const legacyStudentId = select.value;
    if (legacyStudentId) await openGallery(legacyStudentId);
    else clearGallery();
    return;
  }
  const select = $('#projectGalleryStudent');
  const keep = select.value;
  select.innerHTML = '<option value="">Choose a student…</option>' +
    state.projectStudents.map((student) =>
      `<option value="${student.id}">${esc(student.lastName)}, ${esc(student.firstName)}${student.grade ? ` (${esc(student.grade)})` : ''}</option>`
    ).join('');
  select.value = state.projectStudents.some((student) => String(student.id) === keep) ? keep : '';
  if (select.value) await openProjectGallery(select.value);
  else clearGallery();
}

$('#projectGalleryStudent').addEventListener('change', () => openProjectGallery($('#projectGalleryStudent').value));

function clearGallery() {
  state.gallery = null;
  $('#galleryProjectName').hidden = true;
  $('#galleryProjectName').textContent = '';
  $('#galleryStatus').textContent = '';
  $('#galleryStrip').innerHTML = '';
  $('#galleryActions').hidden = true;
  $('#galleryEmailHistory').hidden = true;
  $('#openLink').hidden = true;
}

async function openProjectGallery(studentId) {
  if (!studentId || !state.activeProject) return clearGallery();
  const project = state.activeProject;
  const student = state.projectStudents.find((item) => item.id === Number(studentId));
  state.gallery = student ? { ...student, projectId: project.id, projectName: project.name } : null;
  $('#galleryProjectName').textContent = project.name;
  $('#galleryProjectName').hidden = false;
  const photos = await api(`/api/projects/${project.id}/students/${studentId}/photos`);
  if (Number($('#projectGalleryStudent').value) !== Number(studentId) || state.activeProject?.id !== project.id) return;
  const shots = photos.filter((photo) => !photo.isMarker);
  const gallery = state.gallery;
  $('#galleryStatus').textContent = gallery.republishRequired
    ? 'Previously published; project access is closed. Explicitly republish to restore this gallery.'
    : gallery.publishedAt
    ? `Published ${fmtDate(gallery.publishedAt)} · link open until ${fmtDate(gallery.expiresAt)}`
    : `${shots.length} photo${shots.length === 1 ? '' : 's'}, not published`;
  $('#galleryStrip').innerHTML = shots.length
    ? shots.map((photo) => `<div class="shot-card ${photo.hidden ? 'is-hidden' : ''}" data-id="${photo.id}">
        <img src="/api/photos/${photo.id}/file?size=thumb" alt="" loading="lazy">
        <div class="bar photo-actions">
          <button class="ghost small" data-act="toggle" data-hidden="${photo.hidden}">${photo.hidden ? 'Show' : 'Hide'}</button>
          <button class="ghost small" data-act="move">Move</button>
          <button class="ghost small danger" data-act="delete">Delete</button>
        </div>
      </div>`).join('')
    : '<p class="hint">No photos for this student in this project yet.</p>';
  $('#galleryActions').hidden = false;
  $('#publishOne').hidden = Boolean(project.archived_at);
  $('#unpublishOne').hidden = !gallery.publishedAt || gallery.republishRequired || Boolean(project.archived_at);
  const link = gallery.publishedAt && !gallery.republishRequired && !project.archived_at
    ? projectGalleryUrl(gallery.galleryToken)
    : '';
  $('#openLink').hidden = !link;
  $('#openLink').href = link;
  $('#galleryEmailHistory').hidden = true;
  $('#resendGalleryEmail').hidden = true;
}

/* ---------------------------------------------------------------- floor */

async function loadStats() {
  const s = await api('/api/stats');
  state.stats = s;
  state.config = s.config;

  $('#bigNumber').textContent = s.students.remaining;
  $('#bigLabel').textContent =
    s.students.remaining === 0
      ? 'students left to photograph — the floor is clear'
      : `of ${s.students.active} students still to photograph`;

  $('#tiles').innerHTML = s.tiles
    .map(
      (t) =>
        `<button class="tile ${t.state}" data-id="${t.id}" title="${esc(t.name)}${t.grade ? ` · grade ${esc(t.grade)}` : ''} · ${t.n} photo${t.n === 1 ? '' : 's'}"></button>`
    )
    .join('');

  $('#counts').innerHTML = [
    ['Photos uploaded', s.photos.total, ''],
    ['Matched to a student', s.photos.matched, ''],
    ['Cards read', s.photos.markers, ''],
    ['Need review', s.photos.unmatched, s.photos.unmatched ? 'flag' : ''],
    ['Galleries published', s.galleries.published, ''],
    ['Waiting to publish', s.galleries.awaiting, s.galleries.awaiting ? 'wait' : ''],
    ['Emails sent', s.emails.sent, ''],
    ['Emails pending', s.emails.pending, s.emails.pending ? 'wait' : '']
  ]
    .map(([label, n, cls]) => `<div class="count ${cls}"><b class="num">${n}</b><span>${label}</span></div>`)
    .join('');

  const steps = [];
  if (!s.students.active) steps.push('Import your roster on the Roster screen — a CSV with names and parent email addresses.');
  else if (!s.photos.total) steps.push('Print QR cards, then come back here after picture day and upload the camera card.');
  if (s.photos.unmatched) steps.push(`${s.photos.unmatched} photos are waiting in Review.`);
  if (s.students.thin) steps.push(`${s.students.thin} students have fewer than ${s.config.minPhotos} photos. Check whether a card was missed.`);
  if (s.students.noEmail) steps.push(`${s.students.noEmail} students have no parent email on the roster.`);
  if (s.galleries.awaiting) steps.push(`${s.galleries.awaiting} galleries are complete and unpublished. Review them, then publish.`);
  if (s.emails.pending) steps.push(`${s.emails.pending} families have a published gallery but no email yet.`);
  if (!steps.length) steps.push('Nothing needs attention. Every photographed student has a published gallery and an email.');
  $('#nextSteps').innerHTML = `<ul style="margin:0;padding-left:20px;max-width:64ch">${steps.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;

  $('#tagReview').textContent = s.photos.unmatched;
  $('#tagEmail').textContent = s.emails.pending;
  $('#tagRoster').textContent = s.students.active;

  if (!s.emails.configured) {
    const n = $('#emailNotice');
    n.textContent = 'Email delivery is unavailable. You can still export the links as a CSV and send them from the school mail system.';
    n.hidden = false;
  }
}

$('#refresh').addEventListener('click', loadStats);
$('#tiles').addEventListener('click', (e) => {
  const t = e.target.closest('.tile');
  if (!t) return;
  show('galleries');
  if (state.activeProject) {
    $('#projectGalleryStudent').value = t.dataset.id;
    openProjectGallery(t.dataset.id);
  } else {
    $('#galleryStudent').value = t.dataset.id;
    openGallery(t.dataset.id);
  }
});

/* --------------------------------------------------------------- roster */

async function loadStudents() {
  state.students = await api('/api/students');
  renderRoster();
  fillStudentSelects();
  const grades = [...new Set(state.students.map((s) => s.grade).filter(Boolean))].sort();
  for (const sel of [$('#gradeFilter'), $('#cardGrade')]) {
    const keep = sel.value;
    sel.innerHTML =
      `<option value="">${sel.id === 'cardGrade' ? 'Every active student' : 'All grades'}</option>` +
      grades.map((g) => `<option>${esc(g)}</option>`).join('');
    sel.value = keep;
  }
  if (!state.activeProject) await loadProjectStudents();
}

function matches(s, q) {
  if (!q) return true;
  const hay = `${s.firstName} ${s.lastName} ${s.grade || ''} ${s.teacher || ''} ${s.parentEmail || ''} ${s.qrCode}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

function renderRoster() {
  const q = $('#search').value.trim();
  const grade = $('#gradeFilter').value;
  const rows = state.students.filter((s) => matches(s, q) && (!grade || s.grade === grade));
  $('#rosterCount').textContent = `${rows.length} of ${state.students.length} students`;

  $('#rosterTable tbody').innerHTML = rows
    .map((s) => {
      const gallery = s.publishedAt
        ? `<span class="pill live">Published</span>`
        : s.photoCount
        ? `<span class="pill wait">Not published</span>`
        : `<span class="pill none">No photos</span>`;
      return `<tr data-id="${s.id}">
        <td><b>${esc(s.lastName)}, ${esc(s.firstName)}</b>${s.active ? '' : ' <span class="pill none">inactive</span>'}</td>
        <td>${esc(s.grade || '')}</td>
        <td>${esc(s.teacher || '')}</td>
        <td>${s.parentEmail ? esc(s.parentEmail) : '<span class="pill wait">missing</span>'}</td>
        <td class="mono">${esc(s.qrCode)}</td>
        <td class="num">${s.photoCount}</td>
        <td>${gallery}</td>
        <td style="white-space:nowrap">
          <button class="ghost small" data-act="card">Card</button>
          <button class="ghost small" data-act="edit">Edit</button>
          <button class="ghost small" data-act="recode">New code</button>
          <button class="ghost small danger" data-act="delete">Delete</button>
        </td></tr>`;
    })
    .join('');
}

$('#search').addEventListener('input', renderRoster);
$('#gradeFilter').addEventListener('change', renderRoster);

$('#rosterTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('tr').dataset.id);
  const s = state.students.find((x) => x.id === id);

  if (btn.dataset.act === 'card') window.open(`/api/cards.pdf?ids=${id}`, '_blank', 'noopener');

  if (btn.dataset.act === 'recode') {
    if (!confirm(`Give ${s.firstName} a new code? The card they already have stops working.`)) return;
    await api(`/api/students/${id}/recode`, { method: 'POST' });
    toast('New code issued. Print a replacement card.', 'good');
    loadStudents();
  }

  if (btn.dataset.act === 'delete') {
    if (!confirm(`Delete ${s.firstName} ${s.lastName} from the roster? Their photos stay but become unassigned.`)) return;
    await api(`/api/students/${id}`, { method: 'DELETE' });
    loadStudents();
    loadStats();
  }

  if (btn.dataset.act === 'edit') editStudent(s);
});

function editStudent(s) {
  const fields = [
    ['firstName', 'First name'],
    ['lastName', 'Last name'],
    ['grade', 'Grade'],
    ['teacher', 'Teacher or homeroom'],
    ['parentEmail', 'Parent email']
  ];
  const next = { ...s };
  for (const [key, label] of fields) {
    const v = prompt(`${label}:`, next[key] || '');
    if (v === null) return;
    next[key] = v;
  }
  api(`/api/students/${s.id}`, { method: 'PUT', body: next })
    .then(() => { toast('Student updated.', 'good'); loadStudents(); })
    .catch((e) => toast(e.message, 'bad'));
}

$('#addStudent').addEventListener('click', async () => {
  const first = prompt('First name:');
  if (!first) return;
  const last = prompt('Last name:');
  if (!last) return;
  const grade = prompt('Grade (optional):') || '';
  const teacher = prompt('Teacher or homeroom (optional):') || '';
  const parentEmail = prompt('Parent email (optional):') || '';
  try {
    const s = await api('/api/students', { method: 'POST', body: { firstName: first, lastName: last, grade, teacher, parentEmail } });
    toast(`Added ${s.firstName} ${s.lastName} — code ${s.qrCode}`, 'good');
    loadStudents();
    loadStats();
  } catch (e) { toast(e.message, 'bad'); }
});

$('#importOpen').addEventListener('click', () => {
  const p = $('#importPanel');
  p.hidden = !p.hidden;
});

$('#csvFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const csv = await file.text();
  const out = $('#importResult');
  out.hidden = false;
  out.textContent = 'Reading…';
  try {
    const r = await api('/api/students/import', {
      method: 'POST',
      body: { csv, mode: $('#replaceMode').checked ? 'replace' : 'add' }
    });
    out.textContent =
      `${r.total} rows read\n${r.added} students added\n${r.updated} students updated\n` +
      (r.skipped.length ? `${r.skipped.length} skipped:\n` + r.skipped.map((s) => `  line ${s.line}: ${s.why}`).join('\n') : 'nothing skipped');
    toast(`Roster imported — ${r.added} new, ${r.updated} updated.`, 'good');
    loadStudents();
    loadStats();
  } catch (err) {
    out.textContent = err.message;
    toast(err.message, 'bad');
  }
  e.target.value = '';
});

function fillStudentSelects() {
  const opts =
    '<option value="">Choose a student…</option>' +
    state.students
      .map((s) => `<option value="${s.id}">${esc(s.lastName)}, ${esc(s.firstName)}${s.grade ? ` (${esc(s.grade)})` : ''}</option>`)
      .join('');
  for (const id of ['#assignTo', '#galleryStudent']) {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = opts;
    sel.value = keep;
  }
}

/* ---------------------------------------------------------------- cards */

$('#printCards').addEventListener('click', () => {
  const g = $('#cardGrade').value;
  window.open(`/api/cards.pdf${g ? `?grade=${encodeURIComponent(g)}` : ''}`, '_blank', 'noopener');
});

$('#printProjectCards').addEventListener('click', () => {
  const project = state.activeProject;
  if (!isProjectWritable(project)) return toast('Select an active project first.', 'bad');
  const grade = $('#cardGrade').value;
  window.open(`/api/projects/${project.id}/cards.pdf${grade ? `?grade=${encodeURIComponent(grade)}` : ''}`, '_blank', 'noopener');
});

/* --------------------------------------------------------------- upload */

readerReady()
  .then((kind) => ($('#readerText').textContent = `QR reader: ${kind}`))
  .catch(() => ($('#readerText').textContent = 'No QR reader available — photos will upload unsorted.'));

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); })
);
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); })
);
drop.addEventListener('drop', (e) => stageFiles([...e.dataTransfer.files]));
$('#files').addEventListener('change', (e) => { stageFiles([...e.target.files]); e.target.value = ''; });

let busy = false;
let queuedFiles = [];

function stageFiles(list) {
  if (!isProjectWritable()) return toast('Select an active photo project before staging uploads.', 'bad');
  if (busy) return toast('Still uploading the last batch.', 'bad');
  const images = list.filter((file) => /^image\//.test(file.type));
  if (!images.length) return toast('Those files were not images.', 'bad');
  queuedFiles = images;
  renderUploadQueue();
}

function renderUploadQueue() {
  const panel = $('#queuePanel');
  const list = $('#uploadQueue');
  list.replaceChildren();
  queuedFiles.forEach((file, index) => {
    const item = document.createElement('li');
    const number = document.createElement('span');
    number.className = 'queue-number';
    number.textContent = `${index + 1}.`;
    const name = document.createElement('span');
    name.className = 'queue-name';
    name.textContent = file.name;
    const actions = document.createElement('span');
    actions.className = 'queue-actions';
    for (const [direction, label, disabled] of [
      ['up', 'Move up', index === 0],
      ['down', 'Move down', index === queuedFiles.length - 1]
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost small';
      button.dataset.move = direction;
      button.dataset.index = String(index);
      button.textContent = label;
      button.disabled = busy || disabled;
      button.setAttribute('aria-label', `${label}: ${file.name}`);
      actions.append(button);
    }
    item.append(number, name, actions);
    list.append(item);
  });
  panel.hidden = queuedFiles.length === 0;
  $('#startUpload').disabled = busy || queuedFiles.length === 0 || !isProjectWritable();
  $('#clearUploadQueue').disabled = busy || queuedFiles.length === 0;
}

$('#uploadQueue').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-move]');
  if (!button || busy) return;
  const index = Number(button.dataset.index);
  const destination = index + (button.dataset.move === 'up' ? -1 : 1);
  if (destination < 0 || destination >= queuedFiles.length) return;
  [queuedFiles[index], queuedFiles[destination]] = [queuedFiles[destination], queuedFiles[index]];
  renderUploadQueue();
});

$('#clearUploadQueue').addEventListener('click', () => {
  if (busy) return;
  queuedFiles = [];
  renderUploadQueue();
});

$('#startUpload').addEventListener('click', uploadQueuedFiles);

async function uploadQueuedFiles() {
  if (!queuedFiles.length || busy) return;
  const project = state.activeProject;
  if (!isProjectWritable(project)) return toast('Select an active photo project before uploading.', 'bad');
  busy = true;

  const files = queuedFiles.slice();
  renderUploadQueue();
  const log = $('#uploadLog');
  log.hidden = false;
  log.textContent = '';
  const line = (t) => { log.textContent += t + '\n'; log.scrollTop = log.scrollHeight; };

  try {
    const batch = await api('/api/batches', {
      method: 'POST',
      body: {
        name: $('#batchName').value || `Batch ${new Date().toLocaleString()}`,
        projectId: project.id
      }
    });
    queuedFiles = [];
    renderUploadQueue();
    line(`Batch “${batch.name}” — ${files.length} files`);

    let done = 0, codes = 0, failed = 0;
    const bar = $('#bar');
    const text = $('#progressText');
    bar.style.width = '0';

    const queue = files.map((file, seq) => ({ file, seq }));
    const worker = async () => {
      while (queue.length) {
        const { file, seq } = queue.shift();
        try {
          const { qr, thumb, capturedAt } = await scan(file);
          const form = new FormData();
          form.append('file', file, file.name);
          if (thumb) form.append('thumb', thumb, 'thumb.jpg');
          form.append('batchId', batch.id);
          form.append('seq', String(seq));
          form.append('capturedAt', String(capturedAt));
          if (qr) { form.append('qr', qr); codes++; line(`card found in ${file.name}: ${qr}`); }
          await api('/api/upload', { method: 'POST', body: form });
        } catch (err) {
          failed++;
          line(`failed ${file.name}: ${err.message}`);
        }
        done++;
        bar.style.width = `${(done / files.length) * 100}%`;
        text.textContent = `${done} of ${files.length} uploaded · ${codes} cards read${failed ? ` · ${failed} failed` : ''}`;
      }
    };

    await Promise.all([worker(), worker(), worker()]);

    const sorted = await api(`/api/batches/${batch.id}/sort`, { method: 'POST' });
    line(`sorted: ${sorted.markers} cards, ${sorted.matched} photos matched, ${sorted.unmatched} unmatched`);
    if (sorted.unknownCodes.length) line(`codes not on the roster: ${sorted.unknownCodes.join(', ')}`);
    text.textContent = `Done. ${sorted.matched} photos matched, ${sorted.unmatched} need review.`;
    toast(`Batch finished — ${sorted.matched} matched, ${sorted.unmatched} to review.`, sorted.unmatched ? '' : 'good');

    loadStats();
    loadBatches();
    loadStudents();
  } catch (err) {
    line(`batch failed: ${err.message}`);
    toast(err.message, 'bad');
  } finally {
    busy = false;
    renderUploadQueue();
  }
}

async function loadBatches() {
  const rows = await api(`/api/batches${state.activeProject ? `?projectId=${state.activeProject.id}` : ''}`);
  $('#batchTable tbody').innerHTML = rows
    .map(
      (b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.project_name || 'Legacy')}</td><td class="num">${b.photos}</td><td>${fmtDate(b.created_at)}</td>
        <td>${b.sorted_at ? fmtDate(b.sorted_at) : '<span class="pill wait">not sorted</span>'}</td>
        <td><button class="ghost small" data-batch="${b.id}">Sort again</button>
          <button class="ghost small danger" data-batch-delete="${b.id}" data-batch-name="${esc(b.name)}" data-batch-count="${b.photos}">Delete</button></td></tr>`
    )
    .join('');
}

$('#batchTable').addEventListener('click', async (e) => {
  const deleteButton = e.target.closest('button[data-batch-delete]');
  if (deleteButton) {
    const name = deleteButton.dataset.batchName;
    const count = Number(deleteButton.dataset.batchCount) || 0;
    if (!confirm(`Permanently delete batch “${name}” and its ${count} photos, including full-size files and thumbnails? Published galleries will lose these photos; existing gallery links and email history will remain.`)) return;
    try {
      const result = await api(`/api/batches/${deleteButton.dataset.batchDelete}`, { method: 'DELETE' });
      toast(`Batch deleted. ${result.deletedPhotos} photos and their files removed.`, 'good');
      await loadBatches();
      await loadStats();
      await loadStudents();
      const galleryId = $('#galleryStudent').value;
      if (galleryId) await openGallery(galleryId);
    } catch (err) {
      toast(err.message, 'bad');
    }
    return;
  }
  const btn = e.target.closest('button[data-batch]');
  if (!btn) return;
  const r = await api(`/api/batches/${btn.dataset.batch}/sort`, { method: 'POST' });
  toast(`Re-sorted: ${r.matched} matched, ${r.unmatched} unmatched.`, 'good');
  loadBatches();
  loadStats();
});

/* --------------------------------------------------------------- review */

async function loadReview() {
  const projectQuery = state.activeProject ? `?projectId=${state.activeProject.id}` : '';
  const photos = await api(`/api/photos/unassigned${projectQuery}`);
  state.selected.clear();
  updateSelCount();
  $('#reviewStrip').innerHTML = photos.length
    ? photos
        .map(
          (p) => `<div class="shot-card" data-id="${p.id}">
            <img src="/api/photos/${p.id}/file?size=thumb" alt="${esc(p.original || 'photo')}" loading="lazy">
            <div class="bar photo-actions">
              <label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" data-sel="${p.id}" style="width:auto"> pick</label>
              <span>${p.capturedAt ? new Date(p.capturedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span>
              <button class="ghost small danger" data-delete-photo="${p.id}">Delete</button>
            </div>
          </div>`
        )
        .join('')
    : '<p class="hint">Nothing to review. Every photo found a student.</p>';
}

$('#reloadReview').addEventListener('click', loadReview);

$('#reviewStrip').addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG') return openLightbox(e.target.src.replace('?size=thumb', ''));
  const deleteButton = e.target.closest('button[data-delete-photo]');
  if (deleteButton) {
    deletePhoto(deleteButton.dataset.deletePhoto).then((deleted) => deleted && loadReview());
    return;
  }
  const cb = e.target.closest('input[data-sel]');
  if (!cb) return;
  const id = Number(cb.dataset.sel);
  cb.checked ? state.selected.add(id) : state.selected.delete(id);
  updateSelCount();
});

const updateSelCount = () => ($('#selCount').textContent = `${state.selected.size} selected`);

$('#assignSelected').addEventListener('click', async () => {
  const studentId = $('#assignTo').value;
  if (!studentId) return toast('Choose a student first.', 'bad');
  if (!state.selected.size) return toast('Pick at least one photo.', 'bad');
  for (const id of state.selected) await api(`/api/photos/${id}/assign`, { method: 'POST', body: { studentId } });
  toast(`${state.selected.size} photos assigned.`, 'good');
  loadReview();
  loadStats();
  loadStudents();
});

$('#hideSelected').addEventListener('click', async () => {
  if (!state.selected.size) return toast('Pick at least one photo.', 'bad');
  for (const id of state.selected) await api(`/api/photos/${id}/hide`, { method: 'POST', body: { hidden: true } });
  toast('Hidden from galleries.', 'good');
  loadReview();
  loadStats();
});

/* ------------------------------------------------------------ galleries */

$('#galleryStudent').addEventListener('change', (e) => openGallery(e.target.value));

async function openGallery(id) {
  if (state.activeProject) return openProjectGallery(id);
  if (!id) {
    clearGallery();
    $('#resendGalleryEmail').disabled = true;
    return;
  }
  $('#publishOne').hidden = false;
  $('#unpublishOne').hidden = false;
  $('#resendGalleryEmail').hidden = false;
  const s = state.students.find((x) => x.id === Number(id));
  state.gallery = s;
  $('#galleryProjectName').textContent = LEGACY_GALLERY_NAME;
  $('#galleryProjectName').hidden = false;
  $('#resendGalleryEmail').disabled = true;
  const photos = await api(`/api/students/${id}/photos`);
  if (Number($('#galleryStudent').value) !== Number(id)) return;
  const shots = photos.filter((p) => !p.isMarker);

  $('#galleryStatus').textContent = s.publishedAt
    ? `Published ${fmtDate(s.publishedAt)} · link open until ${fmtDate(s.expiresAt)}`
    : `${shots.length} photo${shots.length === 1 ? '' : 's'}, not published`;

  $('#galleryStrip').innerHTML = shots.length
    ? shots
        .map(
          (p) => `<div class="shot-card ${p.hidden ? 'is-hidden' : ''}" data-id="${p.id}">
            <img src="/api/photos/${p.id}/file?size=thumb" alt="" loading="lazy">
            <div class="bar photo-actions">
              <button class="ghost small" data-act="toggle" data-hidden="${p.hidden}">${p.hidden ? 'Show' : 'Hide'}</button>
              <button class="ghost small" data-act="move">Move</button>
              <button class="ghost small danger" data-act="delete">Delete</button>
            </div>
          </div>`
        )
        .join('')
    : '<p class="hint">No photos for this student yet.</p>';

  $('#galleryActions').hidden = false;
  const link = s.publishedAt && s.galleryToken ? galleryUrl(s.galleryToken) : '';
  $('#openLink').hidden = !link;
  $('#openLink').href = link;
  $('#galleryEmailHistory').hidden = false;
  await loadGalleryEmailHistory(id);
}

async function refreshCurrentGallery() {
  return state.activeProject
    ? openProjectGallery($('#projectGalleryStudent').value)
    : openGallery($('#galleryStudent').value);
}

async function deletePhoto(id) {
  if (!confirm('Permanently delete this photo, its full-size file, and its thumbnail? If published, it will disappear from the gallery; the gallery link and email history will remain.')) return false;
  try {
    await api(`/api/photos/${id}`, { method: 'DELETE' });
    toast('Photo deleted.', 'good');
    await Promise.all([loadStats(), loadStudents()]);
    return true;
  } catch (err) {
    toast(err.message, 'bad');
    return false;
  }
}

async function loadGalleryEmailHistory(id) {
  const history = await api(`/api/students/${id}/email-history`);
  if (Number($('#galleryStudent').value) !== Number(id)) return;
  const latest = history.attempts[0];
  const summary = $('#galleryEmailSummary');

  $('#resendGalleryEmail').disabled = !history.published || !history.hasValidRecipient;
  $('#galleryEmailRecipient').textContent = history.recipientEmail
    ? `Current recipient on file: ${history.recipientEmail}`
    : 'No recipient email is on file.';

  if (!history.published) {
    summary.textContent = 'Gallery is not published. Resending is unavailable.';
    summary.classList.remove('bad');
  } else if (!history.hasValidRecipient) {
    summary.textContent = 'No valid recipient email is on file.';
    summary.classList.add('bad');
  } else if (latest?.outcome === 'rejected') {
    const diagnostics = latest.diagnostic_json ? JSON.parse(latest.diagnostic_json) : null;
    const detail = diagnostics?.status
      ? ` (HTTP ${diagnostics.status})`
      : diagnostics?.smtpCode
        ? ` (SMTP ${diagnostics.smtpCode})`
        : '';
    summary.textContent = `Latest attempt: email delivery rejected the message${detail}.`;
    summary.classList.add('bad');
  } else if (latest?.outcome === 'accepted' || latest?.status === 'sent') {
    summary.textContent = 'Latest attempt: the email gateway accepted the message.';
    summary.classList.remove('bad');
  } else if (latest?.outcome === 'unknown') {
    const diagnostics = latest.diagnostic_json ? JSON.parse(latest.diagnostic_json) : null;
    summary.textContent = `Latest attempt outcome is unknown${diagnostics?.unknownReason ? ` (${diagnostics.unknownReason})` : ''}.`;
    summary.classList.add('bad');
  } else if (latest?.status === 'failed') {
    summary.textContent = `Latest attempt failed: ${latest.error_message || 'No failure reason was recorded.'}`;
    summary.classList.add('bad');
  } else if (latest?.status === 'pending') {
    summary.textContent = 'Latest attempt is pending or was interrupted; delivery status is unknown.';
    summary.classList.remove('bad');
  } else {
    summary.textContent = 'No gallery email attempts have been recorded.';
    summary.classList.remove('bad');
  }

  $('#galleryEmailAttempts').innerHTML = history.attempts.length
    ? history.attempts.map((attempt) => {
        const diagnostics = attempt.diagnostic_json ? JSON.parse(attempt.diagnostic_json) : null;
        const status = attempt.outcome === 'rejected'
          ? 'Gateway rejected'
          : attempt.outcome === 'unknown'
            ? 'Outcome unknown'
            : attempt.status === 'sent'
              ? 'Gateway accepted'
              : attempt.status === 'failed'
                ? 'Failed'
                : 'Pending / unknown';
        const details = [
          diagnostics?.status ? `HTTP ${diagnostics.status}` : '',
          diagnostics?.smtpCode ? `SMTP ${diagnostics.smtpCode}` : '',
          diagnostics?.smtpResponse || diagnostics?.gatewayMessage || attempt.error_message || '',
          diagnostics?.errorCode || '',
          diagnostics?.errorType || '',
          diagnostics?.transportMessage || ''
        ].filter(Boolean).join(' — ');
        return `<tr>
          <td>${esc(new Date(attempt.attempted_at).toLocaleString())}</td>
          <td>${esc(attempt.recipient_email)}</td>
          <td>${status}</td>
          <td>${esc(details)}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="4" class="hint">No attempts recorded.</td></tr>';
}

$('#resendGalleryEmail').addEventListener('click', async () => {
  const student = state.gallery;
  if (!student || $('#resendGalleryEmail').disabled) return;

  $('#resendGalleryEmail').disabled = true;
  try {
    const result = await api(`/api/students/${student.id}/resend-gallery-email`, { method: 'POST' });
    toast('Gallery email sent.', 'good');
    await loadGalleryEmailHistory(student.id);
    loadPending();
    loadStats();
  } catch (error) {
    toast(error.message, 'bad');
    await loadGalleryEmailHistory(student.id);
  }
});

$('#galleryStrip').addEventListener('click', async (e) => {
  if (e.target.tagName === 'IMG') return openLightbox(e.target.src.replace('?size=thumb', ''));
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.shot-card').dataset.id;
  if (btn.dataset.act === 'delete') {
    if (await deletePhoto(id)) await refreshCurrentGallery();
    return;
  }
  if (btn.dataset.act === 'toggle') {
    await api(`/api/photos/${id}/hide`, { method: 'POST', body: { hidden: btn.dataset.hidden !== 'true' } });
    refreshCurrentGallery();
  }
  if (btn.dataset.act === 'move') {
    const name = prompt('Move this photo to which student? Type part of the last name:');
    if (!name) return;
    const hits = state.students.filter((s) => `${s.lastName} ${s.firstName}`.toLowerCase().includes(name.toLowerCase()));
    if (!hits.length) return toast('No student matched that.', 'bad');
    const target = hits.length === 1 ? hits[0] : hits.find((h) => confirm(`Move to ${h.firstName} ${h.lastName}?`));
    if (!target) return;
    await api(`/api/photos/${id}/assign`, { method: 'POST', body: { studentId: target.id } });
    toast(`Moved to ${target.firstName} ${target.lastName}.`, 'good');
    refreshCurrentGallery();
  }
});

$('#publishOne').addEventListener('click', async () => {
  if (state.activeProject) {
    const id = $('#projectGalleryStudent').value;
    if (!id || !isProjectWritable()) return;
    try {
      await api(`/api/projects/${state.activeProject.id}/students/${id}/publish`, { method: 'POST' });
      toast('This project gallery is published.', 'good');
      await loadProjectStudents();
    } catch (error) {
      toast(error.message, 'bad');
    }
    return;
  }
  const id = $('#galleryStudent').value;
  if (!id) return;
  const s = await api(`/api/students/${id}/publish`, { method: 'POST' });
  toast('Gallery published. No email has been sent yet.', 'good');
  await loadStudents();
  openGallery(id);
  loadStats();
});

$('#unpublishOne').addEventListener('click', async () => {
  if (state.activeProject) {
    const id = $('#projectGalleryStudent').value;
    if (!id) return;
    await api(`/api/projects/${state.activeProject.id}/students/${id}/unpublish`, { method: 'POST' });
    toast('This project gallery is closed. Other project galleries are unchanged.', 'good');
    await loadProjectStudents();
    return;
  }
  const id = $('#galleryStudent').value;
  if (!id) return;
  await api(`/api/students/${id}/unpublish`, { method: 'POST' });
  toast('Gallery closed. The link no longer opens.', 'good');
  await loadStudents();
  openGallery(id);
  loadStats();
});

$('#copyLink').addEventListener('click', async () => {
  if (state.activeProject) {
    const student = state.gallery;
    if (!student?.publishedAt || !student.galleryToken) return toast('Publish this project gallery first.', 'bad');
    const link = projectGalleryUrl(student.galleryToken);
    if (!link) return toast('Set the public gallery URL in Settings before copying family links.', 'bad');
    await navigator.clipboard.writeText(link);
    toast('Project gallery link copied.', 'good');
    return;
  }
  const s = state.students.find((x) => x.id === Number($('#galleryStudent').value));
  if (!s?.publishedAt || !s.galleryToken) return toast('Publish the gallery first.', 'bad');
  const link = galleryUrl(s.galleryToken);
  if (!link) return toast('Set the public gallery URL in Settings before copying family links.', 'bad');
  await navigator.clipboard.writeText(link);
  toast('Link copied.', 'good');
});

$('#publishReady').addEventListener('click', async () => {
  if (state.activeProject) return;
  if (!confirm('Publish every student who has enough photos and is not published yet?')) return;
  const r = await api('/api/publish/ready', { method: 'POST' });
  toast(`${r.published} galleries published.`, 'good');
  loadStudents();
  loadStats();
});

$('#publishProjectReady').addEventListener('click', async () => {
  if (!isProjectWritable()) return toast('Select an active project first.', 'bad');
  if (!confirm(`Publish every ready gallery in “${state.activeProject.name}”? Other projects are unchanged.`)) return;
  try {
    const result = await api(`/api/projects/${state.activeProject.id}/publish-ready`, { method: 'POST' });
    toast(`${result.published} project galleries published.`, 'good');
    await loadProjectStudents();
  } catch (error) {
    toast(error.message, 'bad');
  }
});

/* ---------------------------------------------------------------- email */

let emailProjectsLoaded = false;
let emailSelectionVersion = 0;

async function loadEmailProjects() {
  const projects = (await api('/api/projects')).filter((project) => !project.archived_at);
  const select = $('#emailProject');
  select.innerHTML = '<option value="legacy">Original Picture Day</option>' +
    projects.map((project) => `<option value="${project.id}">${esc(project.name)}${project.archived_at ? ' — archived' : ''}</option>`).join('');
  select.value = 'legacy';
  emailProjectsLoaded = true;
}

async function loadPending() {
  if (!emailProjectsLoaded) await loadEmailProjects();
  const selectionVersion = ++emailSelectionVersion;
  const projectId = $('#emailProject').value || 'legacy';
  $('#emailExport').href = `/api/email/export.csv?projectId=${encodeURIComponent(projectId)}`;

  const rows = await api(`/api/email/pending?projectId=${encodeURIComponent(projectId)}`);
  if (selectionVersion !== emailSelectionVersion || projectId !== $('#emailProject').value) return;
  const cfg = await api('/api/config');
  if (selectionVersion !== emailSelectionVersion || projectId !== $('#emailProject').value) return;
  $('#emSubject').value = cfg.emailSubject;
  $('#emBody').value = cfg.emailBody;
  $('#emFrom').value = cfg.emailFrom || '';
  $('#emReply').value = cfg.emailReplyTo || '';
  $('#pendingTable tbody').innerHTML = rows.length
    ? rows
        .map(
          (s) => `<tr><td><input type="checkbox" data-send="${s.id}" style="width:auto" checked></td>
          <td>${esc(s.lastName)}, ${esc(s.firstName)}</td><td>${esc(s.grade || '')}</td><td>${esc(s.parentEmail)}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="hint">Nobody is waiting on an email.</td></tr>';
  $('#pendCount').textContent = `${rows.length} waiting`;
}

$('#emailProject').addEventListener('change', () => {
  loadPending().catch((error) => toast(error.message, 'bad'));
});

$('#pendAll').addEventListener('change', (e) =>
  $$('#pendingTable input[data-send]').forEach((cb) => (cb.checked = e.target.checked))
);

$('#saveEmail').addEventListener('click', async () => {
  await api('/api/config', {
    method: 'PUT',
    body: {
      emailSubject: $('#emSubject').value,
      emailBody: $('#emBody').value,
      emailFrom: $('#emFrom').value,
      emailReplyTo: $('#emReply').value
    }
  });
  toast('Message saved.', 'good');
});

$('#sendTest').addEventListener('click', async () => {
  try {
    await api('/api/email/test', { method: 'POST', body: { to: $('#testTo').value } });
    toast('Test sent.', 'good');
  } catch (e) { toast(e.message, 'bad'); }
});

$('#sendEmails').addEventListener('click', async () => {
  const ids = $$('#pendingTable input[data-send]:checked').map((cb) => Number(cb.dataset.send));
  if (!ids.length) return toast('Nobody is selected.', 'bad');
  if (!confirm(`Send gallery links to ${ids.length} families?`)) return;
  const projectId = $('#emailProject').value || 'legacy';
  try {
    const r = await api('/api/email/send', { method: 'POST', body: { ids, projectId } });
    toast(`${r.sent} sent${r.failed ? `, ${r.failed} failed` : ''}.`, r.failed ? 'bad' : 'good');
    loadPending();
    loadStats();
  } catch (e) { toast(e.message, 'bad'); }
});

/* ------------------------------------------------------------- settings */

function fillConfig(cfg) {
  $('#cfPrefix').value = cfg.codePrefix;
  $('#cfYear').value = cfg.year;
  $('#cfDays').value = cfg.galleryDays;
  $('#cfMin').value = cfg.minPhotos;
  $('#cfUrl').value = cfg.publicUrl || '';
}

$('#saveConfig').addEventListener('click', async () => {
  const cfg = await api('/api/config', {
    method: 'PUT',
    body: {
      codePrefix: $('#cfPrefix').value.trim() || 'PD',
      year: $('#cfYear').value.trim(),
      galleryDays: Number($('#cfDays').value),
      minPhotos: Number($('#cfMin').value),
      publicUrl: $('#cfUrl').value.trim()
    }
  });
  state.config = cfg;
  toast('Settings saved.', 'good');
  loadStats();
});

$('#savePassword').addEventListener('click', async () => {
  try {
    await api('/api/password', { method: 'POST', body: { current: $('#pwOld').value, next: $('#pwNew').value } });
    $('#pwOld').value = $('#pwNew').value = '';
    toast('Password changed.', 'good');
  } catch (e) { toast(e.message, 'bad'); }
});

async function loadStaffAccounts() {
  const users = await api('/api/staff-users');
  $('#staffCount').textContent = `${users.length} of 5 staff accounts in use`;
  $('#staffTable tbody').innerHTML = users
    .map((user) => `<tr><td>${esc(user.username)}${user.id === me.user.id ? ' (you)' : ''}</td><td class="num">${user.id === me.user.id ? '' : `<button class="ghost small danger" data-remove-staff="${user.id}">Remove</button>`}</td></tr>`)
    .join('');
  $('#addStaff').disabled = users.length >= 5;
}

$('#staffForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/staff-users', {
      method: 'POST',
      body: { username: $('#staffUsername').value, password: $('#staffPassword').value }
    });
    $('#staffUsername').value = '';
    $('#staffPassword').value = '';
    toast('Staff account added.', 'good');
    await loadStaffAccounts();
  } catch (e) { toast(e.message, 'bad'); }
});

$('#staffTable').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-remove-staff]');
  if (!button) return;
  const row = button.closest('tr');
  const username = row.cells[0].textContent.replace(' (you)', '');
  if (!confirm(`Remove the staff account for ${username}? They will no longer be able to sign in.`)) return;
  try {
    await api(`/api/staff-users/${button.dataset.removeStaff}`, { method: 'DELETE' });
    toast('Staff account removed.', 'good');
    await loadStaffAccounts();
  } catch (e) { toast(e.message, 'bad'); }
});

/* ------------------------------------------------------------ lightbox */

const lightbox = $('#lightbox');
function openLightbox(src) {
  $('#lightboxImg').src = src;
  lightbox.classList.add('on');
}
lightbox.addEventListener('click', () => { lightbox.classList.remove('on'); $('#lightboxImg').src = ''; });
document.addEventListener('keydown', (e) => e.key === 'Escape' && lightbox.classList.remove('on'));

/* ----------------------------------------------------------------- go */

await loadStudents();
await loadProjects();
await loadStats();
fillConfig(state.config);
show(location.hash.slice(1) || 'floor');
