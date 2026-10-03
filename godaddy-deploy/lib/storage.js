'use strict';

const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const configuredStorageRoot = String(process.env.PD_STORAGE_ROOT || '').trim();

if (configuredStorageRoot && !path.isAbsolute(configuredStorageRoot)) {
  throw new Error('PD_STORAGE_ROOT must be an absolute filesystem path.');
}

const STORAGE_ROOT = configuredStorageRoot ? path.resolve(configuredStorageRoot) : APP_ROOT;
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'pictureday.db');
const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads');
const UP_FULL = path.join(UPLOADS_DIR, 'full');
const UP_THUMB = path.join(UPLOADS_DIR, 'thumb');
const UP_BRAND = path.join(UPLOADS_DIR, 'brand');

const LEGACY_DATA_DIR = path.join(APP_ROOT, 'data');
const LEGACY_DB_PATH = path.join(LEGACY_DATA_DIR, 'pictureday.db');
const LEGACY_UPLOADS_DIR = path.join(APP_ROOT, 'uploads');
const LEGACY_UP_FULL = path.join(LEGACY_UPLOADS_DIR, 'full');
const LEGACY_UP_THUMB = path.join(LEGACY_UPLOADS_DIR, 'thumb');
const LEGACY_UP_BRAND = path.join(LEGACY_UPLOADS_DIR, 'brand');

const MIGRATION_TARGET_ROOT = configuredStorageRoot
  ? STORAGE_ROOT
  : path.resolve('/private/picture-day');

module.exports = {
  APP_ROOT,
  STORAGE_ROOT,
  DATA_DIR,
  DB_PATH,
  UPLOADS_DIR,
  UP_FULL,
  UP_THUMB,
  UP_BRAND,
  LEGACY_DATA_DIR,
  LEGACY_DB_PATH,
  LEGACY_UP_FULL,
  LEGACY_UP_THUMB,
  LEGACY_UP_BRAND,
  MIGRATION_TARGET_ROOT,
  PD_STORAGE_ROOT: configuredStorageRoot || null
};