'use strict';

const crypto = require('crypto');
const mysql = require('mysql2/promise');

const REQUIRED_TABLES = [
  'users',
  'students',
  'batches',
  'photos',
  'email_log',
  'gallery_email_attempts',
  'settings',
  'sessions'
];
const REQUIRED_COLUMNS = {
  users: ['id', 'username', 'password', 'role', 'must_change_password', 'created_at'],
  students: ['id', 'ext_id', 'first_name', 'last_name', 'grade', 'teacher', 'parent_email', 'parent_name', 'qr_code', 'gallery_token', 'expires_at', 'published_at', 'notes', 'active', 'created_at'],
  batches: ['id', 'name', 'created_at', 'sorted_at'],
  photos: ['id', 'batch_id', 'student_id', 'file', 'thumb', 'original', 'bytes', 'captured_at', 'seq_index', 'qr_value', 'is_marker', 'hidden', 'published', 'assigned_by', 'created_at'],
  email_log: ['id', 'student_id', 'to_email', 'status', 'detail', 'sent_at'],
  gallery_email_attempts: ['id', 'student_id', 'recipient_email', 'email_type', 'attempted_at', 'status', 'error_message'],
  settings: ['key', 'value'],
  sessions: ['sid', 'sess', 'expires_at']
};

const requiredEnv = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  throw new Error(`MySQL configuration is incomplete. Set: ${missingEnv.join(', ')}.`);
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  connectTimeout: 10000,
  namedPlaceholders: true,
  supportBigNumbers: false,
  decimalNumbers: true,
  charset: 'utf8mb4'
});

function normalizeSql(sql) {
  return sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, ':$1');
}

function statement(sql, executor = pool) {
  const execute = async (params) => {
    const values = params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])
      ? params[0]
      : params;
    const [result] = await executor.execute(normalizeSql(sql), values);
    return result;
  };

  return {
    async get(...params) {
      const rows = await execute(params);
      return rows[0];
    },
    async all(...params) {
      return execute(params);
    },
    async run(...params) {
      const result = await execute(params);
      return { lastInsertRowid: Number(result.insertId || 0), changes: result.affectedRows || 0 };
    }
  };
}

const db = {
  prepare: statement,
  async ping() {
    await pool.query('SELECT 1');
  },
  async close() {
    await pool.end();
  },
  async tableReadiness() {
    const [tables] = await pool.execute(
      `SELECT TABLE_NAME AS name FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
      [process.env.MYSQL_DATABASE]
    );
    const [columns] = await pool.execute(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
       FROM information_schema.columns WHERE table_schema = ?`,
      [process.env.MYSQL_DATABASE]
    );
    const names = new Set(tables.map((row) => row.name));
    const availableColumns = new Map();
    for (const column of columns) {
      if (!availableColumns.has(column.table_name)) availableColumns.set(column.table_name, new Set());
      availableColumns.get(column.table_name).add(column.column_name);
    }
    const missingColumns = Object.entries(REQUIRED_COLUMNS).flatMap(([table, required]) =>
      required.filter((column) => !availableColumns.get(table)?.has(column)).map((column) => `${table}.${column}`)
    );
    return {
      ready: REQUIRED_TABLES.every((name) => names.has(name)) && missingColumns.length === 0,
      required: REQUIRED_TABLES,
      present: REQUIRED_TABLES.filter((name) => names.has(name)),
      missingColumns
    };
  },
  async transaction(callback) {
    const connection = await pool.getConnection();
    const tx = { prepare: (sql) => statement(sql, connection) };
    try {
      await connection.beginTransaction();
      const result = await callback(tx);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('MySQL transaction rollback failed:', rollbackError.message);
      }
      throw error;
    } finally {
      connection.release();
    }
  }
};

async function initialize() {
  try {
    await db.ping();
  } catch (error) {
    throw new Error(`Could not connect to the configured MySQL database: ${error.message}`, { cause: error });
  }

  const schema = [
    `CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(191) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'staff',
      must_change_password TINYINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS students (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ext_id VARCHAR(191) NULL,
      first_name VARCHAR(191) NOT NULL,
      last_name VARCHAR(191) NOT NULL,
      grade VARCHAR(100) NULL,
      teacher VARCHAR(191) NULL,
      parent_email VARCHAR(254) NULL,
      parent_name VARCHAR(191) NULL,
      qr_code VARCHAR(64) NOT NULL UNIQUE,
      gallery_token VARCHAR(128) NULL UNIQUE,
      expires_at BIGINT NULL,
      published_at BIGINT NULL,
      notes TEXT NULL,
      active TINYINT NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL,
      KEY idx_students_ext_id (ext_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS batches (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at BIGINT NOT NULL,
      sorted_at BIGINT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS photos (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      batch_id BIGINT UNSIGNED NULL,
      student_id BIGINT UNSIGNED NULL,
      file VARCHAR(255) NOT NULL,
      thumb VARCHAR(255) NULL,
      original VARCHAR(255) NULL,
      bytes BIGINT NULL,
      captured_at BIGINT NULL,
      seq_index INT NOT NULL DEFAULT 0,
      qr_value VARCHAR(200) NULL,
      is_marker TINYINT NOT NULL DEFAULT 0,
      hidden TINYINT NOT NULL DEFAULT 0,
      published TINYINT NOT NULL DEFAULT 0,
      assigned_by VARCHAR(32) NULL,
      created_at BIGINT NOT NULL,
      KEY idx_photos_student (student_id),
      KEY idx_photos_batch (batch_id, captured_at, seq_index),
      CONSTRAINT fk_photos_batch FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
      CONSTRAINT fk_photos_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS email_log (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      student_id BIGINT UNSIGNED NULL,
      to_email VARCHAR(254) NULL,
      status VARCHAR(32) NULL,
      detail VARCHAR(300) NULL,
      sent_at BIGINT NOT NULL,
      KEY idx_email_log_student (student_id),
      CONSTRAINT fk_email_log_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS gallery_email_attempts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      student_id BIGINT UNSIGNED NOT NULL,
      recipient_email VARCHAR(254) NOT NULL,
      email_type VARCHAR(32) NOT NULL,
      attempted_at BIGINT NOT NULL,
      status VARCHAR(32) NOT NULL,
      error_message VARCHAR(300) NULL,
      KEY idx_gallery_email_attempts_student_time (student_id, attempted_at),
      CONSTRAINT fk_gallery_attempt_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(191) NOT NULL PRIMARY KEY,
      \`value\` LONGTEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR(191) NOT NULL PRIMARY KEY,
      sess LONGTEXT NOT NULL,
      expires_at BIGINT NULL,
      KEY idx_sessions_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ];

  for (const sql of schema) await pool.query(sql);

  const [passwordColumn] = await pool.execute(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'users' AND column_name = 'must_change_password'`,
    [process.env.MYSQL_DATABASE]
  );
  if (!passwordColumn.length) {
    await pool.query(
      'ALTER TABLE users ADD COLUMN must_change_password TINYINT NOT NULL DEFAULT 0'
    );
  }
  const readiness = await db.tableReadiness();
  if (!readiness.ready) throw new Error('MySQL schema initialization did not create all required tables and columns.');
  await loadSettings();
}

const settingsCache = new Map();

async function loadSettings() {
  const [rows] = await pool.query('SELECT `key`, `value` FROM settings');
  settingsCache.clear();
  for (const row of rows) {
    try {
      settingsCache.set(row.key, JSON.parse(row.value));
    } catch (error) {
      console.error(`Ignoring malformed JSON in setting "${row.key}".`, error);
    }
  }
}

function getSetting(key, fallback = null) {
  return settingsCache.has(key) ? settingsCache.get(key) : fallback;
}

async function setSetting(key, value) {
  await pool.execute(
    'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    [key, JSON.stringify(value)]
  );
  settingsCache.set(key, value);
  return value;
}

const DEFAULT_BRANDING = {
  schoolName: 'Your School',
  eventName: 'Picture Day',
  year: String(new Date().getFullYear()),
  tagline: 'One good photo. That is the whole job.',
  welcome: 'Your photos are ready. Look through them, download the ones you like, and keep this link private — it only works for your family.',
  logo: null,
  palette: { primary: '#16505C', accent: '#E8B33A', ink: '#16202B', paper: '#F7F8F6' },
  surfaces: {
    home: { primary: '#16505C', accent: '#E8B33A', ink: '#16202B', paper: '#F7F8F6', panel: '#FFFFFF', backdrop: 'paper', heroTreatment: 'solid' },
    gallery: { primary: '#16505C', accent: '#E8B33A', ink: '#16202B', paper: '#F7F8F6', panel: '#FFFFFF', backdrop: 'paper', cardStyle: 'clean' }
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
  layouts: { home: ['intro', 'artwork', 'how', 'card', 'photos', 'footer'], gallery: ['galleryHeader', 'galleryWelcome', 'photoGrid', 'footer'] },
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
  emailBody: 'Hello,\n\n{{student}}’s {{event}} photos are ready to view.\n\n{{link}}\n\nThis private link is just for your family and expires on {{expires}}.\n\n— {{school}}'
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

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function randomCode(len = 5) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

async function newQrCode() {
  const cfg = config();
  for (let i = 0; i < 50; i++) {
    const code = `${cfg.codePrefix}-${cfg.year}-${randomCode(5)}`;
    if (!(await db.prepare('SELECT 1 FROM students WHERE qr_code = ?').get(code))) return code;
  }
  throw new Error('Could not generate a unique QR code');
}

function newGalleryToken() {
  return crypto.randomBytes(24).toString('base64url');
}

module.exports = {
  db,
  initialize,
  getSetting,
  setSetting,
  config,
  branding,
  newQrCode,
  newGalleryToken,
  randomCode,
  DEFAULT_BRANDING,
  DEFAULT_CONFIG,
  REQUIRED_TABLES,
  REQUIRED_COLUMNS
};
