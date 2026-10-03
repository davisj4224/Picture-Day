'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  migrationStatus,
  migrateLegacyStorage
} = require('../lib/storage-migration.js');

const APP_ROOT = path.resolve(__dirname, '..');

function createSchema(database) {
  database.exec(`
    CREATE TABLE students (id INTEGER PRIMARY KEY, first_name TEXT);
    CREATE TABLE photos (id INTEGER PRIMARY KEY, file TEXT NOT NULL, thumb TEXT);
    CREATE TABLE batches (id INTEGER PRIMARY KEY);
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE gallery_email_attempts (id INTEGER PRIMARY KEY);
    CREATE TABLE email_log (id INTEGER PRIMARY KEY);
  `);
}

function createFixture(root, { omitThumb = false } = {}) {
  const databasePath = path.join(root, 'data', 'pictureday.db');
  const directories = {
    full: path.join(root, 'uploads', 'full'),
    thumb: path.join(root, 'uploads', 'thumb'),
    brand: path.join(root, 'uploads', 'brand')
  };
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  Object.values(directories).forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
  const database = new Database(databasePath);
  database.pragma('journal_mode = WAL');
  createSchema(database);
  database.exec(`
    INSERT INTO students VALUES (1, 'Ada');
    INSERT INTO students VALUES (2, 'Grace');
    INSERT INTO photos VALUES (11, 'p1.jpg', 'p1.jpg');
    INSERT INTO photos VALUES (12, 'p2.jpg', 'p2.jpg');
    INSERT INTO batches VALUES (21);
    INSERT INTO users VALUES (31);
    INSERT INTO settings VALUES ('branding_draft', '{"logo":"logo.png","blocks":[{"type":"image","src":"block.png"}]}');
    INSERT INTO settings VALUES ('branding_published', '{"artwork":"art.png"}');
    INSERT INTO settings VALUES ('config', '{}');
    INSERT INTO gallery_email_attempts VALUES (41);
    INSERT INTO email_log VALUES (51);
  `);
  for (const filename of ['p1.jpg', 'p2.jpg']) {
    fs.writeFileSync(path.join(directories.full, filename), `full:${filename}`);
    if (!omitThumb || filename === 'p1.jpg') fs.writeFileSync(path.join(directories.thumb, filename), `thumb:${filename}`);
  }
  for (const filename of ['logo.png', 'block.png', 'art.png']) {
    fs.writeFileSync(path.join(directories.brand, filename), `brand:${filename}`);
  }
  return { database, databasePath, directories };
}

async function withTempRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picture-day-storage-test-'));
  try {
    return await callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('migration backs up SQLite and copies assets without changing source files', async () => {
  await withTempRoot(async (root) => {
    const sourceRoot = path.join(root, 'legacy');
    const privateRoot = path.join(root, 'private');
    const source = createFixture(sourceRoot);
    try {
      const before = await migrationStatus({
        legacyDbPath: source.databasePath,
        legacyDirectories: source.directories,
        privateRoot,
        activeDatabase: source.database,
        activeDatabasePath: source.databasePath
      });
      assert.equal(before.legacy.counts.students, 2);
      assert.equal(before.legacy.counts.photos, 2);
      assert.equal(before.private.exists, false);

      const result = await migrateLegacyStorage({
        sourceDatabase: source.database,
        sourceDbPath: source.databasePath,
        sourceDirectories: source.directories,
        privateRoot
      });
      assert.equal(result.migrated, true);
      assert.deepEqual(result.integrityCheck, ['ok']);
      assert.equal(result.counts.students, 2);
      assert.equal(result.counts.galleryEmailHistory, 1);
      assert.equal(result.files.full.copied, 2);
      assert.equal(result.files.thumb.copied, 2);
      assert.equal(result.files.brand.copied, 3);
      assert.equal(result.references.full.ok, true);
      assert.equal(result.references.thumb.ok, true);
      assert.equal(result.references.brand.ok, true);
      assert.equal(fs.existsSync(source.databasePath), true);
      assert.equal(fs.readFileSync(path.join(source.directories.full, 'p1.jpg'), 'utf8'), 'full:p1.jpg');
      assert.equal(fs.readFileSync(path.join(privateRoot, 'uploads', 'brand', 'logo.png'), 'utf8'), 'brand:logo.png');

      const after = await migrationStatus({
        legacyDbPath: source.databasePath,
        legacyDirectories: source.directories,
        privateRoot,
        activeDatabase: source.database,
        activeDatabasePath: source.databasePath
      });
      assert.deepEqual(after.private.integrityCheck, ['ok']);
      assert.deepEqual(after.private.counts, result.counts);
      assert.equal(after.private.files.full, 2);
    } finally {
      source.database.close();
    }
  });
});

test('existing private database requires explicit overwrite and is archived', async () => {
  await withTempRoot(async (root) => {
    const sourceRoot = path.join(root, 'legacy');
    const privateRoot = path.join(root, 'private');
    const source = createFixture(sourceRoot);
    const privateDbPath = path.join(privateRoot, 'data', 'pictureday.db');
    fs.mkdirSync(path.dirname(privateDbPath), { recursive: true });
    const existing = new Database(privateDbPath);
    createSchema(existing);
    existing.prepare('INSERT INTO students VALUES (99, ?)').run('Keep me in backup');
    existing.close();

    try {
      await assert.rejects(
        migrateLegacyStorage({
          sourceDatabase: source.database,
          sourceDbPath: source.databasePath,
          sourceDirectories: source.directories,
          privateRoot
        }),
        (error) => error.statusCode === 409 && /explicit overwrite confirmation/.test(error.message)
      );
      const result = await migrateLegacyStorage({
        sourceDatabase: source.database,
        sourceDbPath: source.databasePath,
        sourceDirectories: source.directories,
        privateRoot,
        overwriteDatabase: true
      });
      assert.equal(result.migrated, true);
      assert.ok(result.overwriteBackupPath);
      const archived = new Database(path.join(result.overwriteBackupPath, 'pictureday.db'), { readonly: true });
      try {
        assert.equal(archived.prepare('SELECT first_name FROM students WHERE id = 99').get().first_name, 'Keep me in backup');
      } finally {
        archived.close();
      }
    } finally {
      source.database.close();
    }
  });
});

test('migration refuses missing referenced files before copying', async () => {
  await withTempRoot(async (root) => {
    const sourceRoot = path.join(root, 'legacy');
    const privateRoot = path.join(root, 'private');
    const source = createFixture(sourceRoot, { omitThumb: true });
    try {
      await assert.rejects(
        migrateLegacyStorage({
          sourceDatabase: source.database,
          sourceDbPath: source.databasePath,
          sourceDirectories: source.directories,
          privateRoot
        }),
        (error) => error.statusCode === 409 && error.details.references.thumb.missingCount === 1
      );
      assert.equal(fs.existsSync(path.join(privateRoot, 'data', 'pictureday.db')), false);
    } finally {
      source.database.close();
    }
  });
});

test('PD_STORAGE_ROOT uses the configured path and refuses a missing database', () => {
  withTempRoot((root) => {
    const storageModule = path.join(APP_ROOT, 'lib', 'storage.js');
    const dbModule = path.join(APP_ROOT, 'lib', 'db.js');
    const storage = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(storageModule)})))`], {
      encoding: 'utf8',
      env: { ...process.env, PD_STORAGE_ROOT: root }
    });
    assert.equal(storage.status, 0, storage.stderr);
    const paths = JSON.parse(storage.stdout);
    assert.equal(paths.DB_PATH, path.join(root, 'data', 'pictureday.db'));
    assert.equal(paths.UP_FULL, path.join(root, 'uploads', 'full'));
    assert.equal(paths.UP_THUMB, path.join(root, 'uploads', 'thumb'));
    assert.equal(paths.UP_BRAND, path.join(root, 'uploads', 'brand'));

    const opening = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(dbModule)})`], {
      encoding: 'utf8',
      env: { ...process.env, PD_STORAGE_ROOT: root }
    });
    assert.notEqual(opening.status, 0);
    assert.match(opening.stderr, /migrated database is missing/);
    assert.equal(fs.existsSync(path.join(root, 'data', 'pictureday.db')), false);

    const emptyRoot = path.join(root, 'empty-database-root');
    fs.mkdirSync(path.join(emptyRoot, 'data'), { recursive: true });
    const emptyDbPath = path.join(emptyRoot, 'data', 'pictureday.db');
    fs.writeFileSync(emptyDbPath, '');
    const emptyOpening = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(dbModule)})`], {
      encoding: 'utf8',
      env: { ...process.env, PD_STORAGE_ROOT: emptyRoot }
    });
    assert.notEqual(emptyOpening.status, 0);
    assert.match(emptyOpening.stderr, /missing expected tables|could not be validated/);
    assert.equal(fs.statSync(emptyDbPath).size, 0);
  });
});