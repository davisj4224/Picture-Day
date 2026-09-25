import { $, $$, api, session, toast, esc } from '/assets/common.js';

const me = await session();
if (!me.user) location.href = '/login';
if (me.user.role === 'staff') $('#publish').hidden = false;

let draft = await api('/api/branding/draft');
const fonts = await api('/api/fonts');

/* Starting points students can pull apart, not finished answers. */
const KITS = [
  { name: 'Gym light', primary: '#16505C', accent: '#E8B33A', ink: '#16202B', paper: '#F7F8F6' },
  { name: 'Marching band', primary: '#7A1F2B', accent: '#E9C46A', ink: '#241214', paper: '#FBF6EF' },
  { name: 'Hallway blue', primary: '#25406E', accent: '#7FC6E8', ink: '#141C2B', paper: '#F2F5FA' },
  { name: 'Late bus', primary: '#3D2C57', accent: '#F09D51', ink: '#1E1727', paper: '#F6F2F8' },
  { name: 'Turf', primary: '#255142', accent: '#C6D94C', ink: '#12211B', paper: '#F4F7F1' },
  { name: 'Darkroom', primary: '#2B2B2B', accent: '#D7443E', ink: '#151515', paper: '#EFEDEA' }
];

$('#kits').innerHTML = KITS.map(
  (k, i) =>
    `<button class="kit" data-i="${i}"><span class="chips"><i style="background:${k.primary}"></i><i style="background:${k.accent}"></i><i style="background:${k.paper};box-shadow:inset 0 0 0 1px #ccc"></i></span><b>${esc(k.name)}</b></button>`
).join('');

for (const sel of ['#fHead', '#fBody'])
  $(sel).innerHTML = fonts.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');

/* ---------------------------------------------------------------- bind */

function fill() {
  $('#school').value = draft.schoolName;
  $('#event').value = draft.eventName;
  $('#year').value = draft.year;
  $('#tagline').value = draft.tagline || '';
  $('#welcome').value = draft.welcome || '';
  $('#credit').value = draft.credit || '';
  $('#cPrimary').value = draft.palette.primary;
  $('#cAccent').value = draft.palette.accent;
  $('#cInk').value = draft.palette.ink;
  $('#cPaper').value = draft.palette.paper;
  $('#fHead').value = draft.headingFont;
  $('#fBody').value = draft.bodyFont;
  $$('#corners button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === draft.cornerStyle)));
  $$('#backdrop button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === draft.backdrop)));
  setImage('#logoImg', draft.logo);
  setImage('#artImg', draft.artwork);
}

function setImage(sel, file) {
  const el = $(sel);
  el.hidden = !file;
  if (file) el.src = `/brand/${encodeURIComponent(file)}?t=${Date.now()}`;
}

function collect() {
  return {
    schoolName: $('#school').value,
    eventName: $('#event').value,
    year: $('#year').value,
    tagline: $('#tagline').value,
    welcome: $('#welcome').value,
    credit: $('#credit').value,
    palette: {
      primary: $('#cPrimary').value,
      accent: $('#cAccent').value,
      ink: $('#cInk').value,
      paper: $('#cPaper').value
    },
    headingFont: $('#fHead').value,
    bodyFont: $('#fBody').value,
    cornerStyle: $$('#corners button').find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.v || 'soft',
    backdrop: $$('#backdrop button').find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.v || 'paper'
  };
}

/* -------------------------------------------------------------- saving */

let timer = null;
let dirty = false;

function touched() {
  dirty = true;
  $('#saveState').textContent = 'Unsaved changes…';
  clearTimeout(timer);
  timer = setTimeout(save, 900);
}

async function save(loud = false) {
  clearTimeout(timer);
  try {
    draft = await api('/api/branding/draft', { method: 'PUT', body: collect() });
    dirty = false;
    $('#saveState').textContent = `Draft saved at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    refresh();
    if (loud) toast('Draft saved.', 'good');
  } catch (e) {
    $('#saveState').textContent = e.message;
    toast(e.message, 'bad');
  }
}

$$('.panel input, .panel select, .panel textarea').forEach((el) => {
  if (el.type === 'file') return;
  el.addEventListener('input', touched);
  el.addEventListener('change', touched);
});

for (const group of ['#corners', '#backdrop']) {
  $(group).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    $$(`${group} button`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    touched();
  });
}

$('#kits').addEventListener('click', (e) => {
  const b = e.target.closest('.kit');
  if (!b) return;
  const k = KITS[Number(b.dataset.i)];
  $('#cPrimary').value = k.primary;
  $('#cAccent').value = k.accent;
  $('#cInk').value = k.ink;
  $('#cPaper').value = k.paper;
  touched();
});

$('#save').addEventListener('click', () => save(true));

$('#revert').addEventListener('click', async () => {
  if (!confirm('Throw away the draft and go back to the design families see now?')) return;
  draft = await api('/api/branding/revert', { method: 'POST' });
  fill();
  refresh();
  toast('Draft reset to the published design.');
});

$('#publish').addEventListener('click', async () => {
  if (dirty) await save();
  if (!confirm('Publish this design? Families and the school page will use it right away.')) return;
  await api('/api/branding/publish', { method: 'POST' });
  toast('Design published.', 'good');
});

/* -------------------------------------------------------------- images */

async function uploadImage(kind, input) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('image', file);
  try {
    draft = await api(`/api/branding/${kind}`, { method: 'POST', body: form });
    setImage(kind === 'logo' ? '#logoImg' : '#artImg', draft[kind]);
    refresh();
    toast(`${kind === 'logo' ? 'Logo' : 'Artwork'} uploaded.`, 'good');
  } catch (e) {
    toast(e.message, 'bad');
  }
  input.value = '';
}

$('#logoFile').addEventListener('change', (e) => uploadImage('logo', e.target));
$('#artFile').addEventListener('change', (e) => uploadImage('artwork', e.target));

for (const [btn, kind, img] of [['#logoClear', 'logo', '#logoImg'], ['#artClear', 'artwork', '#artImg']]) {
  $(btn).addEventListener('click', async () => {
    draft = await api(`/api/branding/${kind}`, { method: 'DELETE' });
    setImage(img, null);
    refresh();
  });
}

/* ------------------------------------------------------------- preview */

const frame = $('#preview');
const refresh = () => frame.contentWindow.location.replace(currentSrc());
let src = '/?draft=1';
const currentSrc = () => src;

$('#target').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-src]');
  if (!b) return;
  $$('#target button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  src = b.dataset.src;
  refresh();
});

$('#reload').addEventListener('click', refresh);

$('#signout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/login';
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

fill();
$('#saveState').textContent = 'Draft loaded.';
