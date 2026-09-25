/* Small shared helpers. No framework — this has to stay readable for
   whoever inherits the project next year. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let csrf = null;

export async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export async function session() {
  const me = await api('/api/me');
  csrf = me.csrf;
  return me;
}

export function setCsrf(token) {
  csrf = token;
}

export function toast(message, kind = '') {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3800);
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export function fontStack(name) {
  const serif = ['Fraunces', 'DM Serif Display', 'Lora', 'Bitter', 'Newsreader'];
  return `'${name}', ${serif.includes(name) ? 'Georgia, serif' : "'Helvetica Neue', Arial, sans-serif"}`;
}

export function loadFonts(names) {
  const families = [...new Set(names.filter(Boolean))]
    .map((n) => `family=${encodeURIComponent(n).replace(/%20/g, '+')}:wght@400;500;600;700`)
    .join('&');
  if (!families) return;
  const id = 'brand-fonts';
  let link = document.getElementById(id);
  if (!link) {
    link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

export function applyBranding(b, root = document.documentElement, surfaceName = 'home') {
  const surface = b.surfaces?.[surfaceName] || b.palette;
  const radius = { sharp: '0px', soft: '8px', round: '20px' }[b.cornerStyle] || '8px';
  root.style.setProperty('--b-primary', surface.primary);
  root.style.setProperty('--b-accent', surface.accent);
  root.style.setProperty('--b-ink', surface.ink);
  root.style.setProperty('--b-paper', surface.paper);
  root.style.setProperty('--b-panel', surface.panel || surface.paper);
  root.style.setProperty('--b-radius', radius);
  root.style.setProperty('--b-heading', fontStack(b.headingFont));
  root.style.setProperty('--b-body', fontStack(b.bodyFont));
  root.dataset.backdrop = surface.backdrop || b.backdrop || 'paper';
  root.dataset.surface = surfaceName;
  if (surface.heroTreatment) root.dataset.heroTreatment = surface.heroTreatment;
  if (surface.cardStyle) root.dataset.cardStyle = surface.cardStyle;
  loadFonts([b.headingFont, b.bodyFont]);
}
