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

const LAYOUTS = {
  home: {
    labels: {
      intro: ['Headline and tagline', 'Main page text block'],
      artwork: ['Hero artwork', 'Main page image'],
      how: ['How the day runs', 'Instruction block'],
      card: ['Bring your card', 'Instruction block'],
      photos: ['Getting the photos', 'Instruction block'],
      footer: ['Footer', 'Credit and closing note']
    },
    fallback: ['intro', 'artwork', 'how', 'card', 'photos', 'footer']
  },
  gallery: {
    labels: {
      galleryHeader: ['Gallery header', 'School name and logo'],
      galleryWelcome: ['Welcome text', 'Student and gallery message'],
      photoGrid: ['Photo grid', 'Family photographs'],
      footer: ['Footer', 'Credit and privacy note']
    },
    fallback: ['galleryHeader', 'galleryWelcome', 'photoGrid', 'footer']
  }
};

function renderLayout(name) {
  const model = LAYOUTS[name];
  const host = $(`#${name === 'home' ? 'homeLayout' : 'galleryLayout'}`);
  const order = draft.layouts?.[name] || model.fallback;
  host.innerHTML = order.map((id) => {
    const [title, detail] = model.labels[id];
    return `<div class="layout-item" draggable="true" data-layout-id="${id}"><span class="handle" aria-hidden="true">⠿</span><span><b>${esc(title)}</b><small>${esc(detail)}</small></span></div>`;
  }).join('');
}

function renderLayouts() {
  renderLayout('home');
  renderLayout('gallery');
}

function layoutOrder(name) {
  return $$('#' + (name === 'home' ? 'homeLayout' : 'galleryLayout') + ' .layout-item').map((item) => item.dataset.layoutId);
}

function wireLayoutDrag(name) {
  const host = $(`#${name === 'home' ? 'homeLayout' : 'galleryLayout'}`);
  host.addEventListener('dragstart', (event) => {
    const item = event.target.closest('.layout-item');
    if (!item) return;
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.dataset.layoutId);
  });
  host.addEventListener('dragend', (event) => event.target.closest('.layout-item')?.classList.remove('dragging'));
  host.addEventListener('dragover', (event) => {
    event.preventDefault();
    const dragging = host.querySelector('.dragging');
    const target = event.target.closest('.layout-item');
    if (!dragging || !target || dragging === target) return;
    const box = target.getBoundingClientRect();
    target.parentNode.insertBefore(dragging, event.clientY < box.top + box.height / 2 ? target : target.nextSibling);
  });
  host.addEventListener('drop', (event) => {
    event.preventDefault();
    draft.layouts[name] = layoutOrder(name);
    touched();
  });
}

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
  $('#heroHeadline').value = draft.hero?.headline || '';
  $('#heroTagline').value = draft.hero?.tagline || '';
  $('#heroX').value = draft.hero?.x || 0;
  $('#heroY').value = draft.hero?.y || 0;
  $('#artCaption').value = draft.heroArt?.caption || '';
  $('#artKicker').value = draft.heroArt?.kicker || '';
  $('#artTitle').value = draft.heroArt?.title || '';
  $('#artSubline').value = draft.heroArt?.subline || '';
  $('#artX').value = draft.heroArt?.x || 0;
  $('#artY').value = draft.heroArt?.y || 0;
  $('#cPrimary').value = draft.palette.primary;
  $('#cAccent').value = draft.palette.accent;
  $('#cInk').value = draft.palette.ink;
  $('#cPaper').value = draft.palette.paper;
  syncColorValues();
  fillSurface('home', 'h');
  fillSurface('gallery', 'g');
  $('#fHead').value = draft.headingFont;
  $('#fBody').value = draft.bodyFont;
  $$('#corners button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === draft.cornerStyle)));
  $$('#backdrop button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === draft.backdrop)));
  setImage('#logoImg', draft.logo);
  setImage('#artImg', draft.artwork);
  setImage('#galleryArtImg', draft.galleryArtwork);
  renderLayouts();
  renderBlocks();
}

function renderBlocks() {
  const host = $('#blocks');
  host.innerHTML = (draft.blocks || []).map((block, index) => `
    <div class="design-block" data-block-index="${index}">
      <header><b>${block.type === 'image' ? 'Image' : 'Text'} ${index + 1}</b><button class="ghost small" data-remove-block type="button">Remove</button></header>
      ${block.type === 'text' ? `<textarea data-block-field="text" maxlength="240">${esc(block.text)}</textarea>` : `<img src="/brand/${encodeURIComponent(block.src)}" alt="" style="display:block;max-width:100%;max-height:80px;margin-bottom:8px">`}
      <div class="block-grid">
        <label>X %<input type="number" min="0" max="92" step="1" data-block-field="x" value="${block.x}"></label>
        <label>Y %<input type="number" min="0" max="92" step="1" data-block-field="y" value="${block.y}"></label>
        <label>Width %<input type="number" min="8" max="100" step="1" data-block-field="width" value="${block.width}"></label>
        <label>Size ${block.type === 'text' ? 'rem' : '(unused)'}<input type="number" min="0.7" max="8" step="0.1" data-block-field="size" value="${block.size}" ${block.type === 'image' ? 'disabled' : ''}></label>
      </div>
      <label style="display:block;margin-top:7px;font-size:.72rem;color:var(--ink-2)">Colour
        <select data-block-field="color"><option value="ink" ${block.color === 'ink' ? 'selected' : ''}>Text</option><option value="primary" ${block.color === 'primary' ? 'selected' : ''}>Main</option><option value="accent" ${block.color === 'accent' ? 'selected' : ''}>Accent</option><option value="paper" ${block.color === 'paper' ? 'selected' : ''}>Background</option></select>
      </label>
    </div>`).join('');
}

const COLOR_FIELDS = [
  ['#cPrimary', '#vPrimary'],
  ['#cAccent', '#vAccent'],
  ['#cInk', '#vInk'],
  ['#cPaper', '#vPaper']
];

function syncColorValues() {
  COLOR_FIELDS.forEach(([color, value]) => { $(value).value = $(color).value; });
}

const SURFACE_FIELDS = [
  ['home', 'h'],
  ['gallery', 'g']
];

function fillSurface(name, prefix) {
  const surface = draft.surfaces[name];
  ['Primary', 'Accent', 'Ink', 'Paper'].forEach((part) => {
    $(`#${prefix}${part}`).value = surface[part.toLowerCase()];
    $(`#${prefix}v${part}`).value = surface[part.toLowerCase()];
  });
  const backdrop = name === 'home' ? surface.backdrop : surface.backdrop;
  const style = name === 'home' ? surface.heroTreatment : surface.cardStyle;
  const styleGroup = name === 'home' ? '#heroTreatment' : '#cardStyle';
  $$(`#${name === 'home' ? 'homeBackdrop' : 'galleryBackdrop'} button`).forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.v === backdrop)));
  $$(styleGroup + ' button').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.v === style)));
}

COLOR_FIELDS.forEach(([color, value]) => {
  $(color).addEventListener('input', () => { $(value).value = $(color).value; touched(); });
  $(value).addEventListener('change', () => {
    const next = $(value).value.trim();
    if (/^#[0-9a-f]{6}$/i.test(next)) {
      $(color).value = next;
      touched();
    } else {
      $(value).value = $(color).value;
    }
  });
});

SURFACE_FIELDS.forEach(([name, prefix]) => {
  ['Primary', 'Accent', 'Ink', 'Paper'].forEach((part) => {
    const color = $(`#${prefix}${part}`);
    const value = $(`#${prefix}v${part}`);
    color.addEventListener('input', () => { value.value = color.value; touched(); });
    value.addEventListener('change', () => {
      if (/^#[0-9a-f]{6}$/i.test(value.value.trim())) {
        color.value = value.value.trim();
        touched();
      } else value.value = color.value;
    });
  });
});

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
    hero: {
      headline: $('#heroHeadline').value,
      tagline: $('#heroTagline').value,
      x: $('#heroX').value,
      y: $('#heroY').value
    },
    heroArt: {
      caption: $('#artCaption').value,
      kicker: $('#artKicker').value,
      title: $('#artTitle').value,
      subline: $('#artSubline').value,
      x: $('#artX').value,
      y: $('#artY').value
    },
    palette: {
      primary: $('#cPrimary').value,
      accent: $('#cAccent').value,
      ink: $('#cInk').value,
      paper: $('#cPaper').value
    },
    surfaces: {
      home: collectSurface('home', 'h'),
      gallery: collectSurface('gallery', 'g')
    },
    layouts: {
      home: layoutOrder('home'),
      gallery: layoutOrder('gallery')
    },
    blocks: $$('#blocks .design-block').map((element, index) => {
      const block = draft.blocks[index];
      const value = (field) => element.querySelector(`[data-block-field="${field}"]`)?.value;
      return { ...block, text: value('text') ?? block.text, x: value('x'), y: value('y'), width: value('width'), size: value('size'), color: value('color') };
    }),
    headingFont: $('#fHead').value,
    bodyFont: $('#fBody').value,
    cornerStyle: $$('#corners button').find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.v || 'soft',
    backdrop: $$('#backdrop button').find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.v || 'paper'
  };
}

function collectSurface(name, prefix) {
  return {
    primary: $(`#${prefix}Primary`).value,
    accent: $(`#${prefix}Accent`).value,
    ink: $(`#${prefix}Ink`).value,
    paper: $(`#${prefix}Paper`).value,
    panel: draft.surfaces[name].panel,
    backdrop: $$(name === 'home' ? '#homeBackdrop button' : '#galleryBackdrop button').find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.v || 'paper',
    ...(name === 'home'
      ? { heroTreatment: $$('#heroTreatment button').find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.v || 'solid' }
      : { cardStyle: $$('#cardStyle button').find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.v || 'clean' })
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

for (const group of ['#corners', '#backdrop', '#homeBackdrop', '#heroTreatment', '#galleryBackdrop', '#cardStyle']) {
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
  ['h', 'g'].forEach((prefix) => {
    $(`#${prefix}Primary`).value = k.primary;
    $(`#${prefix}Accent`).value = k.accent;
    $(`#${prefix}Ink`).value = k.ink;
    $(`#${prefix}Paper`).value = k.paper;
    $(`#${prefix}vPrimary`).value = k.primary;
    $(`#${prefix}vAccent`).value = k.accent;
    $(`#${prefix}vInk`).value = k.ink;
    $(`#${prefix}vPaper`).value = k.paper;
  });
  touched();
});

$('#save').addEventListener('click', () => save(true));

$('#blocks').addEventListener('input', touched);
$('#blocks').addEventListener('change', touched);
$('#blocks').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-block]');
  if (!button) return;
  draft.blocks.splice(Number(button.closest('[data-block-index]').dataset.blockIndex), 1);
  renderBlocks();
  touched();
});

$('#addTextBlock').addEventListener('click', () => {
  draft.blocks.push({ id: `block-${Date.now()}`, type: 'text', text: 'New text', src: '', x: 8, y: 8, width: 40, size: 1.4, color: 'ink' });
  renderBlocks();
  touched();
});

$('#revert').addEventListener('click', async () => {
  if (!confirm('Throw away the draft and go back to the design families see now?')) return;
  draft = await api('/api/branding/revert', { method: 'POST' });
  fill();
  refresh();
  toast('Draft reset to the published design.');
});

for (const [name, button] of [['home', '#resetHomeLayout'], ['gallery', '#resetGalleryLayout']]) {
  $(button).addEventListener('click', () => {
    draft.layouts[name] = [...LAYOUTS[name].fallback];
    renderLayouts();
    touched();
  });
  wireLayoutDrag(name);
}

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
$('#galleryArtFile').addEventListener('change', (e) => uploadImage('galleryArtwork', e.target));
$('#blockImageFile').addEventListener('change', async (e) => {
  const input = e.target;
  if (!input.files[0]) return;
  const form = new FormData();
  form.append('image', input.files[0]);
  try {
    draft = await api('/api/branding/block-image', { method: 'POST', body: form });
    renderBlocks();
    refresh();
    toast('Image block added.', 'good');
  } catch (error) {
    toast(error.message, 'bad');
  }
  input.value = '';
});

for (const [btn, kind, img] of [['#logoClear', 'logo', '#logoImg'], ['#artClear', 'artwork', '#artImg'], ['#galleryArtClear', 'galleryArtwork', '#galleryArtImg']]) {
  $(btn).addEventListener('click', async () => {
    draft = await api(`/api/branding/${kind}`, { method: 'DELETE' });
    setImage(img, null);
    refresh();
  });
}

/* ------------------------------------------------------------- preview */

const frame = $('#preview');
const refresh = () => {
  $('#previewState').textContent = 'Loading preview…';
  frame.contentWindow.location.replace(`${currentSrc()}${currentSrc().includes('?') ? '&' : '?'}t=${Date.now()}`);
};
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

frame.addEventListener('load', () => { $('#previewState').textContent = 'Preview ready'; });

$('#viewport').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-viewport]');
  if (!button) return;
  $$('#viewport button').forEach((x) => x.setAttribute('aria-pressed', String(x === button)));
  frame.classList.remove('canvas-tablet', 'canvas-mobile');
  if (button.dataset.viewport !== 'desktop') frame.classList.add(`canvas-${button.dataset.viewport}`);
});

$('#signout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/login';
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save(true);
  }
});

fill();
$('#saveState').textContent = 'Draft loaded.';
