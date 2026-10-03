'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test } = require('node:test');

const appRoot = path.join(__dirname, '..');
const databaseSource = fs.readFileSync(path.join(appRoot, 'lib', 'db.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8');

test('schema is additive and includes all persistent application tables', () => {
  for (const table of [
    'users',
    'students',
    'photos',
    'batches',
    'settings',
    'email_log',
    'gallery_email_attempts',
    'sessions'
  ]) {
    assert.match(databaseSource, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
  assert.doesNotMatch(databaseSource, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\s+(users|students|photos|batches|settings|email_log|gallery_email_attempts)\b/i);
  assert.doesNotMatch(serverSource, /better-sqlite3|SqliteSessionStore|pictureday\.db/);
});

test('private photo files are guarded from static access and keep route-based access', () => {
  assert.match(serverSource, /assets.*full\|thumb/);
  assert.match(serverSource, /app\.get\('\/api\/photos\/:id\/file', requireStaff/);
  assert.match(serverSource, /app\.get\('\/api\/gallery\/:token\/photo\/:id'/);
  assert.match(serverSource, /app\.get\('\/api\/admin\/database-health', requireAdmin/);
  assert.doesNotMatch(serverSource, /\/api\/debug\/storage-check-7f3a9c/);
});

const testDatabase = process.env.DB_TEST_NAME || '';
const safeDedicatedDatabase = /(^|_)test($|_)/i.test(testDatabase);
const integrationReady = safeDedicatedDatabase &&
  ['DB_HOST', 'DB_USER', 'DB_PASSWORD'].every((name) => Boolean(process.env[name]));

test('MySQL state and file references survive schema re-initialization', {
  skip: integrationReady ? false : 'Set DB_TEST_NAME to a dedicated database whose name contains "_test" and configure DB_HOST, DB_USER, DB_PASSWORD.'
}, async () => {
  process.env.DB_NAME = testDatabase;
  const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pictureday-mysql-test-'));
  process.env.PICTUREDAY_ASSET_DIR = assetRoot;
  const assetPaths = ['full', 'thumb', 'brand'].map((name) => path.join(assetRoot, name));
  assetPaths.forEach((directory) => fs.mkdirSync(directory, { recursive: true }));

  let databaseModule = require('../lib/db');
  let { db, initialize } = databaseModule;
  const suffix = crypto.randomBytes(8).toString('hex');
  const username = `persist-${suffix}`;
  const qrCode = `PD-2026-${suffix.toUpperCase()}`;
  const token = crypto.randomBytes(24).toString('base64url');
  const settingKey = `persistence-test-${suffix}`;
  const fullName = `${suffix}.jpg`;
  const thumbName = `${suffix}.jpg`;
  const fullPath = path.join(assetRoot, 'full', fullName);
  const thumbPath = path.join(assetRoot, 'thumb', thumbName);
  let studentId;
  let batchId;
  let photoId;

  try {
    await initialize();
    const user = await db.prepare(
      'INSERT INTO users (username, password, role, created_at) VALUES (?, ?, ?, ?)'
    ).run(username, 'test-hash-only', 'admin', Date.now());
    const student = await db.prepare(
      `INSERT INTO students (first_name, last_name, qr_code, gallery_token, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('Persistence', suffix, qrCode, token, Date.now(), Date.now());
    studentId = student.lastInsertRowid;
    const batch = await db.prepare('INSERT INTO batches (name, created_at) VALUES (?, ?)').run(`Batch ${suffix}`, Date.now());
    batchId = batch.lastInsertRowid;
    await db.prepare(
      `INSERT INTO settings (\`key\`, \`value\`) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`)`
    ).run(settingKey, JSON.stringify({ marker: suffix }));

    fs.writeFileSync(fullPath, 'full-photo-test');
    fs.writeFileSync(thumbPath, 'thumbnail-test');
    const photo = await db.prepare(
      `INSERT INTO photos (batch_id, student_id, file, thumb, original, bytes, seq_index, qr_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(batchId, null, fullName, thumbName, 'camera.jpg', 16, 0, qrCode, Date.now());
    photoId = photo.lastInsertRowid;
    await db.prepare(
      `INSERT INTO gallery_email_attempts
       (student_id, recipient_email, email_type, attempted_at, status)
       VALUES (?, ?, 'gallery', ?, 'failed')`
    ).run(studentId, 'family@example.test', Date.now());
    await db.prepare(
      'INSERT INTO email_log (student_id, to_email, status, sent_at) VALUES (?, ?, ?, ?)'
    ).run(studentId, 'family@example.test', 'failed', Date.now());

    const markerPhoto = await db.prepare(
      `INSERT INTO photos (batch_id, file, original, seq_index, qr_value, is_marker, hidden, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)`
    ).run(batchId, `${suffix}-following.jpg`, 'following.jpg', 1, null, Date.now());
    await db.transaction(async (tx) => {
      const roster = await tx.prepare('SELECT id, qr_code FROM students').all();
      const studentsByCode = new Map(roster.map((row) => [row.qr_code.toUpperCase(), row.id]));
      const batchPhotos = await tx.prepare(
        'SELECT id, qr_value, assigned_by FROM photos WHERE batch_id = ? ORDER BY seq_index, id'
      ).all(batchId);
      let currentStudent = null;
      for (const photoRow of batchPhotos) {
        const recognizedStudent = studentsByCode.get(String(photoRow.qr_value || '').toUpperCase());
        if (recognizedStudent) {
          currentStudent = recognizedStudent;
          await tx.prepare('UPDATE photos SET student_id = ?, is_marker = 1, hidden = 1 WHERE id = ?')
            .run(currentStudent, photoRow.id);
        } else if (photoRow.assigned_by !== 'staff') {
          await tx.prepare('UPDATE photos SET student_id = ?, is_marker = 0 WHERE id = ?')
            .run(currentStudent, photoRow.id);
        }
      }
      await tx.prepare('UPDATE batches SET sorted_at = ? WHERE id = ?').run(Date.now(), batchId);
    });

    await db.close();
    delete require.cache[require.resolve('../lib/db')];
    databaseModule = require('../lib/db');
    ({ db, initialize } = databaseModule);
    await initialize();

    assert.equal((await db.tableReadiness()).ready, true, 'schema is ready after restart');
    assert.ok(await db.prepare('SELECT id FROM users WHERE username = ?').get(username), 'user persists');
    const persistedStudent = await db.prepare(
      'SELECT gallery_token FROM students WHERE id = ?'
    ).get(studentId);
    assert.equal(persistedStudent.gallery_token, token, 'student and gallery token persist');
    assert.deepEqual(databaseModule.getSetting(settingKey), { marker: suffix }, 'settings load from MySQL');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM batches WHERE id = ?').get(batchId)).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE batch_id = ? AND student_id = ?').get(batchId, studentId)).n, 2);
    const sortedPhotos = await db.prepare(
      'SELECT student_id, is_marker, hidden, qr_value FROM photos WHERE batch_id = ? ORDER BY seq_index'
    ).all(batchId);
    assert.equal(sortedPhotos[0].student_id, studentId);
    assert.equal(sortedPhotos[0].is_marker, 1);
    assert.equal(sortedPhotos[0].hidden, 1);
    assert.equal(sortedPhotos[0].qr_value, qrCode);
    assert.equal(sortedPhotos[1].student_id, studentId);
    assert.equal((await db.prepare('SELECT sorted_at FROM batches WHERE id = ?').get(batchId)).sorted_at > 0, true);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM gallery_email_attempts WHERE student_id = ?').get(studentId)).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE student_id = ?').get(studentId)).n, 1);
    assert.ok(fs.existsSync(path.join(assetRoot, 'full', fullName)));
    assert.ok(fs.existsSync(path.join(assetRoot, 'thumb', thumbName)));

    await db.prepare('DELETE FROM photos WHERE id = ?').run(photoId);
    await fs.promises.rm(fullPath, { force: true });
    await fs.promises.rm(thumbPath, { force: true });
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE id = ?').get(photoId)).n, 0);

    await db.prepare('DELETE FROM batches WHERE id = ?').run(batchId);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE batch_id = ?').get(batchId)).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM batches WHERE id = ?').get(batchId)).n, 0);

    await db.prepare('DELETE FROM students WHERE id = ?').run(studentId);
    await db.prepare('DELETE FROM users WHERE username = ?').run(username);
    await db.prepare('DELETE FROM settings WHERE `key` = ?').run(settingKey);
  } finally {
    if (db) await db.close().catch(() => {});
    fs.rmSync(assetRoot, { recursive: true, force: true });
  }
});
