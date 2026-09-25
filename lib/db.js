'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'pictureday.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'staff',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id             INTEGER PRIMARY KEY,
  ext_id         TEXT,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  grade          TEXT,
  teacher        TEXT,
  parent_email   TEXT,
  parent_name    TEXT,
  qr_code        TEXT UNIQUE NOT NULL,
  gallery_token  TEXT UNIQUE,
  expires_at     INTEGER,
  published_at   INTEGER,
  notes          TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  sorted_at   INTEGER
);

CREATE TABLE IF NOT EXISTS photos (
  id           INTEGER PRIMARY KEY,
  batch_id     INTEGER REFERENCES batches(id) ON DELETE CASCADE,
  student_id   INTEGER REFERENCES students(id) ON DELETE SET NULL,
  file         TEXT NOT NULL,
  thumb        TEXT,
  original     TEXT,
  bytes        INTEGER,
  captured_at  INTEGER,
  seq_index    INTEGER NOT NULL DEFAULT 0,
  qr_value     TEXT,
  is_marker    INTEGER NOT NULL DEFAULT 0,
  hidden       INTEGER NOT NULL DEFAULT 0,
  published    INTEGER NOT NULL DEFAULT 0,
  assigned_by  TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_student ON photos(student_id);
CREATE INDEX IF NOT EXISTS idx_photos_batch   ON photos(batch_id, captured_at, seq_index);

CREATE TABLE IF NOT EXISTS email_log (
  id          INTEGER PRIMARY KEY,
  student_id  INTEGER REFERENCES students(id) ON DELETE CASCADE,
  to_email    TEXT,
  status      TEXT,
  detail      TEXT,
  sent_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`);

/* ---------------------------------------------------------------- settings */

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
  return value;
}

const DEFAULT_BRANDING = {
  schoolName: 'Your School',
  eventName: 'Picture Day',
  year: String(new Date().getFullYear()),
  tagline: 'One good photo. That is the whole job.',
  welcome:
    'Your photos are ready. Look through them, download the ones you like, and keep this link private — it only works for your family.',
  logo: null,
  palette: {
    primary: '#16505C',
    accent: '#E8B33A',
    ink: '#16202B',
    paper: '#F7F8F6'
  },
  surfaces: {
    home: {
      primary: '#16505C',
      accent: '#E8B33A',
      ink: '#16202B',
      paper: '#F7F8F6',
      panel: '#FFFFFF',
      backdrop: 'paper',
      heroTreatment: 'solid'
    },
    gallery: {
      primary: '#16505C',
      accent: '#E8B33A',
      ink: '#16202B',
      paper: '#F7F8F6',
      panel: '#FFFFFF',
      backdrop: 'paper',
      cardStyle: 'clean'
    }
  },
  headingFont: 'Archivo',
  bodyFont: 'Archivo',
  cornerStyle: 'soft',
  backdrop: 'paper',
  artwork: null,
  galleryArtwork: null,
  credit: '',
  hero: { x: 0, y: 0, headline: '', tagline: '' },
  heroArt: { x: 0, y: 0, caption: 'Make room for the good stuff', kicker: 'SMILE', title: 'BIG', subline: "IT'S YOUR DAY" },
  layouts: {
    home: ['intro', 'artwork', 'how', 'card', 'photos', 'footer'],
    gallery: ['galleryHeader', 'galleryWelcome', 'photoGrid', 'footer']
  },
  blocks: []
};

const DEFAULT_CONFIG = {
  codePrefix: 'PD',
  year: String(new Date().getFullYear()),
  galleryDays: 45,
  minPhotos: 2,
  publicUrl: '',
  emailEnabled: false,
  emailSubject: '{{school}} {{event}} photos for {{student}}',
  emailFrom: '',
  emailReplyTo: '',
  emailBody:
    'Hello,\n\n{{student}}\u2019s {{event}} photos are ready to view.\n\n{{link}}\n\nThis private link is just for your family and expires on {{expires}}.\n\n\u2014 {{school}}'
};

function config() {
  return { ...DEFAULT_CONFIG, ...(getSetting('config') || {}) };
}

function branding(which = 'published') {
  const stored = getSetting(which === 'draft' ? 'branding_draft' : 'branding_published');
  if (!stored) return { ...DEFAULT_BRANDING };
  return {
    ...DEFAULT_BRANDING,
    ...stored,
    palette: { ...DEFAULT_BRANDING.palette, ...(stored.palette || {}) },
    surfaces: {
      home: { ...DEFAULT_BRANDING.surfaces.home, ...(stored.surfaces?.home || {}) },
      gallery: { ...DEFAULT_BRANDING.surfaces.gallery, ...(stored.surfaces?.gallery || {}) }
    },
    layouts: {
      home: Array.isArray(stored.layouts?.home) ? stored.layouts.home : [...DEFAULT_BRANDING.layouts.home],
      gallery: Array.isArray(stored.layouts?.gallery) ? stored.layouts.gallery : [...DEFAULT_BRANDING.layouts.gallery]
    },
    hero: { ...DEFAULT_BRANDING.hero, ...(stored.hero || {}) },
    heroArt: { ...DEFAULT_BRANDING.heroArt, ...(stored.heroArt || {}) },
    blocks: Array.isArray(stored.blocks) ? stored.blocks : []
  };
}

/* ------------------------------------------------------------------ tokens */

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I

function randomCode(len = 5) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function newQrCode() {
  const cfg = config();
  for (let i = 0; i < 50; i++) {
    const code = `${cfg.codePrefix}-${cfg.year}-${randomCode(5)}`;
    const clash = db.prepare('SELECT 1 FROM students WHERE qr_code = ?').get(code);
    if (!clash) return code;
  }
  throw new Error('Could not generate a unique QR code');
}

function newGalleryToken() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = {
  db,
  DATA_DIR,
  getSetting,
  setSetting,
  config,
  branding,
  newQrCode,
  newGalleryToken,
  randomCode,
  DEFAULT_BRANDING,
  DEFAULT_CONFIG
};
