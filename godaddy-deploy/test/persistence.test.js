'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { test } = require('node:test');
const {
  publishStudentRecord,
  galleryStudentByToken,
  galleryLink
} = require('../lib/gallery');

const appRoot = path.join(__dirname, '..');
const databaseSource = fs.readFileSync(path.join(appRoot, 'lib', 'db.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8');

test('schema is additive and includes all persistent application tables', () => {
  for (const table of [
    'users',
    'students',
    'projects',
    'project_students',
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
  assert.match(serverSource, /app\.use\(denyPhotoAssetStaticAccess\)/);
  assert.match(serverSource, /app\.get\('\/api\/photos\/:id\/file', requireStaff/);
  assert.match(serverSource, /app\.get\('\/api\/gallery\/:token\/photo\/:id'/);
  assert.match(serverSource, /app\.get\('\/api\/admin\/database-health', requireAdmin/);
  assert.doesNotMatch(serverSource, /\/api\/debug\/storage-check-7f3a9c/);
});

const testDatabase = process.env.DB_TEST_NAME || '';
const safeDedicatedDatabase = /(^|_)test($|_)/i.test(testDatabase);
const integrationReady = safeDedicatedDatabase &&
  ['DB_HOST', 'DB_USER', 'DB_PASSWORD'].every((name) => Boolean(process.env[name]));

test('pre-feature MySQL schema migrates without changing existing records', {
  skip: integrationReady ? false : 'Set DB_TEST_NAME to a dedicated database whose name contains "_test" and configure DB_HOST, DB_USER, DB_PASSWORD.'
}, async () => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const safePrefix = testDatabase.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40) || 'pictureday_test';
  const migrationDatabase = `${safePrefix}_migration_${suffix}`;
  const previousDatabase = process.env.DB_NAME;
  const dbModulePath = require.resolve('../lib/db');
  let adminConnection;
  let db;
  let databaseCreated = false;

  try {
    adminConnection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });
    await adminConnection.query(`CREATE DATABASE \`${migrationDatabase}\` CHARACTER SET utf8mb4`);
    databaseCreated = true;
    process.env.DB_NAME = migrationDatabase;
    delete require.cache[dbModulePath];
    ({ db } = require('../lib/db'));

    await db.prepare(
      `CREATE TABLE students (
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ).run();
    await db.prepare(
      `CREATE TABLE projects (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL,
        created_at BIGINT NOT NULL,
        archived_at BIGINT NULL,
        KEY idx_projects_active (archived_at, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ).run();
    await db.prepare(
      `CREATE TABLE project_students (
        project_id BIGINT UNSIGNED NOT NULL,
        student_id BIGINT UNSIGNED NOT NULL,
        qr_code VARCHAR(80) NULL UNIQUE,
        gallery_token VARCHAR(128) NULL UNIQUE,
        expires_at BIGINT NULL,
        published_at BIGINT NULL,
        PRIMARY KEY (project_id, student_id),
        KEY idx_project_students_student (student_id),
        KEY idx_project_students_project_published (project_id, published_at),
        CONSTRAINT fk_project_students_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CONSTRAINT fk_project_students_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ).run();
    await db.prepare(
      `CREATE TABLE batches (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at BIGINT NOT NULL,
        sorted_at BIGINT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ).run();
    await db.prepare(
      `CREATE TABLE photos (
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ).run();
    await db.prepare(
      `CREATE TABLE gallery_email_attempts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        student_id BIGINT UNSIGNED NOT NULL,
        recipient_email VARCHAR(254) NOT NULL,
        email_type VARCHAR(32) NOT NULL,
        attempted_at BIGINT NOT NULL,
        status VARCHAR(32) NOT NULL,
        error_message VARCHAR(300) NULL,
        KEY idx_gallery_email_attempts_student_time (student_id, attempted_at),
        CONSTRAINT fk_gallery_attempt_student FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ).run();

    const qrCode = `PD-OLD-${suffix}`;
    const galleryToken = `legacy-${suffix}`;
    const createdAt = Date.now();
    const student = await db.prepare(
      `INSERT INTO students (first_name, last_name, qr_code, gallery_token, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('Legacy', 'Student', qrCode, galleryToken, createdAt, createdAt);
    const archivedProjectId = (await db.prepare(
      'INSERT INTO projects (name, created_at, archived_at) VALUES (?, ?, ?)'
    ).run('Archived before migration', createdAt, createdAt)).lastInsertRowid;
    const activeProjectId = (await db.prepare(
      'INSERT INTO projects (name, created_at) VALUES (?, ?)'
    ).run('Active before migration', createdAt)).lastInsertRowid;
    const archivedProjectQr = `PD-P${archivedProjectId}-OLD-${suffix}`;
    const archivedProjectToken = `archived-project-${suffix}`;
    const archivedPublishedAt = createdAt - 1000;
    await db.prepare(
      `INSERT INTO project_students (project_id, student_id, qr_code, gallery_token, expires_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      archivedProjectId,
      student.lastInsertRowid,
      archivedProjectQr,
      archivedProjectToken,
      createdAt + 86400000,
      archivedPublishedAt
    );
    const activeProjectQr = `PD-P${activeProjectId}-OLD-${suffix}`;
    const activeProjectToken = `active-project-${suffix}`;
    await db.prepare(
      `INSERT INTO project_students (project_id, student_id, qr_code, gallery_token, expires_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      activeProjectId,
      student.lastInsertRowid,
      activeProjectQr,
      activeProjectToken,
      createdAt + 86400000,
      createdAt
    );
    const batch = await db.prepare(
      'INSERT INTO batches (name, created_at) VALUES (?, ?)'
    ).run('Legacy batch', createdAt);
    const photo = await db.prepare(
      `INSERT INTO photos (batch_id, student_id, file, original, qr_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(batch.lastInsertRowid, student.lastInsertRowid, 'legacy-photo.jpg', 'camera.jpg', qrCode, createdAt);
    const attempt = await db.prepare(
      `INSERT INTO gallery_email_attempts
       (student_id, recipient_email, email_type, attempted_at, status, error_message)
       VALUES (?, ?, 'gallery', ?, 'failed', ?)`
    ).run(student.lastInsertRowid, 'legacy@example.test', createdAt, 'legacy failure');

    const { initialize } = require('../lib/db');
    await initialize();
    assert.equal((await db.tableReadiness()).ready, true);

    const migratedAttempt = await db.prepare(
      `SELECT student_id, recipient_email, email_type, attempted_at, status, error_message,
         project_id, outcome, diagnostic_json, message_id
       FROM gallery_email_attempts WHERE id = ?`
    ).get(attempt.lastInsertRowid);
    assert.equal(migratedAttempt.student_id, student.lastInsertRowid);
    assert.equal(migratedAttempt.recipient_email, 'legacy@example.test');
    assert.equal(migratedAttempt.status, 'failed');
    assert.equal(migratedAttempt.error_message, 'legacy failure');
    assert.equal(migratedAttempt.project_id, null);
    assert.equal(migratedAttempt.outcome, null);
    assert.equal(migratedAttempt.diagnostic_json, null);
    assert.equal(migratedAttempt.message_id, null);

    const migratedStudent = await db.prepare(
      'SELECT qr_code, gallery_token FROM students WHERE id = ?'
    ).get(student.lastInsertRowid);
    assert.equal(migratedStudent.qr_code, qrCode);
    assert.equal(migratedStudent.gallery_token, galleryToken);
    assert.equal((await db.prepare('SELECT project_id FROM batches WHERE id = ?').get(batch.lastInsertRowid)).project_id, null);
    assert.equal((await db.prepare('SELECT project_id FROM photos WHERE id = ?').get(photo.lastInsertRowid)).project_id, null);

    const migratedArchivedMembership = await db.prepare(
      `SELECT qr_code, gallery_token, published_at, republish_required
       FROM project_students WHERE project_id = ? AND student_id = ?`
    ).get(archivedProjectId, student.lastInsertRowid);
    assert.equal(migratedArchivedMembership.qr_code, archivedProjectQr);
    assert.equal(migratedArchivedMembership.gallery_token, archivedProjectToken);
    assert.equal(migratedArchivedMembership.published_at, archivedPublishedAt);
    assert.equal(Number(migratedArchivedMembership.republish_required), 1);
    const migratedActiveMembership = await db.prepare(
      `SELECT qr_code, gallery_token, published_at, republish_required
       FROM project_students WHERE project_id = ? AND student_id = ?`
    ).get(activeProjectId, student.lastInsertRowid);
    assert.equal(migratedActiveMembership.qr_code, activeProjectQr);
    assert.equal(migratedActiveMembership.gallery_token, activeProjectToken);
    assert.equal(migratedActiveMembership.published_at, createdAt);
    assert.equal(Number(migratedActiveMembership.republish_required), 0);

    const republishColumn = await db.prepare(
      `SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS default_value
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'project_students'
         AND column_name = 'republish_required'`
    ).get(migrationDatabase);
    assert.equal(republishColumn.name, 'republish_required');
    assert.equal(republishColumn.nullable, 'NO');
    assert.equal(Number(republishColumn.default_value), 0);

    const diagnosticColumns = await db.prepare(
      `SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'gallery_email_attempts'
         AND column_name IN ('project_id', 'outcome', 'diagnostic_json', 'message_id')`
    ).all(migrationDatabase);
    assert.equal(diagnosticColumns.length, 4);
    assert.ok(diagnosticColumns.every((column) => column.nullable === 'YES'));

    await initialize();
    assert.equal((await db.tableReadiness()).ready, true, 'second initialization remains successful');
    const repeatedAttempt = await db.prepare(
      'SELECT status, error_message, outcome, diagnostic_json, message_id FROM gallery_email_attempts WHERE id = ?'
    ).get(attempt.lastInsertRowid);
    assert.equal(repeatedAttempt.status, 'failed');
    assert.equal(repeatedAttempt.error_message, 'legacy failure');
    assert.equal(repeatedAttempt.outcome, null);
    assert.equal(repeatedAttempt.diagnostic_json, null);
    assert.equal(repeatedAttempt.message_id, null);
    const repeatedArchivedMembership = await db.prepare(
      `SELECT qr_code, gallery_token, published_at, republish_required
       FROM project_students WHERE project_id = ? AND student_id = ?`
    ).get(archivedProjectId, student.lastInsertRowid);
    assert.deepEqual(repeatedArchivedMembership, migratedArchivedMembership);
    const repeatedActiveMembership = await db.prepare(
      `SELECT qr_code, gallery_token, published_at, republish_required
       FROM project_students WHERE project_id = ? AND student_id = ?`
    ).get(activeProjectId, student.lastInsertRowid);
    assert.deepEqual(repeatedActiveMembership, migratedActiveMembership);
  } finally {
    if (db) await db.close().catch(() => {});
    delete require.cache[dbModulePath];
    if (previousDatabase === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = previousDatabase;
    if (adminConnection) {
      try {
        if (databaseCreated) await adminConnection.query(`DROP DATABASE \`${migrationDatabase}\``);
      } finally {
        await adminConnection.end();
      }
    }
  }
});

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
  const galleryToken = crypto.randomBytes(24).toString('base64url');
  const settingKey = `persistence-test-${suffix}`;
  const fullName = `${suffix}.jpg`;
  const thumbName = `${suffix}.jpg`;
  const fullPath = path.join(assetRoot, 'full', fullName);
  const thumbPath = path.join(assetRoot, 'thumb', thumbName);
  let studentId;
  let galleryStudentId;
  let batchId;
  let photoId;
  let projectId;
  let projectBatchId;

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
    const importedGalleryStudent = await db.prepare(
      `INSERT INTO students (ext_id, first_name, last_name, parent_email, qr_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(`gallery-${suffix}`, 'Gallery', suffix, 'family@example.test', `PD-2026-IMPORT-${suffix}`, Date.now());
    galleryStudentId = importedGalleryStudent.lastInsertRowid;
    const publicUrl = 'https://calcharterpicts.org';
    const publishedGallery = await publishStudentRecord(db, galleryStudentId, 45, () => galleryToken, { info() {} });
    assert.equal(publishedGallery.gallery_token, galleryToken);
    assert.ok(publishedGallery.published_at, 'publish timestamp is persisted');
    assert.ok(publishedGallery.expires_at > Date.now(), 'expiration is persisted in the future');
    assert.equal((await galleryStudentByToken(db, galleryToken)).student.id, galleryStudentId);
    assert.equal(galleryLink(publishedGallery.gallery_token, publicUrl), `${publicUrl}/g/${galleryToken}`);

    await db.prepare('UPDATE students SET first_name = ? WHERE id = ?').run('Roster update', galleryStudentId);
    const afterRosterUpdate = await db.prepare('SELECT * FROM students WHERE id = ?').get(galleryStudentId);
    assert.equal(afterRosterUpdate.gallery_token, galleryToken, 'roster updates preserve publication token');
    assert.equal(afterRosterUpdate.published_at, publishedGallery.published_at);
    assert.equal(afterRosterUpdate.expires_at, publishedGallery.expires_at);

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
      `INSERT INTO gallery_email_attempts
       (student_id, recipient_email, email_type, attempted_at, status, outcome, diagnostic_json, message_id)
       VALUES (?, ?, 'gallery', ?, 'failed', ?, ?, ?)`
    ).run(
      studentId,
      'family@example.test',
      Date.now(),
      'rejected',
      JSON.stringify({ outcome: 'rejected', smtpCode: 550 }),
      'gateway-test-message-id'
    );
    await db.prepare(
      'INSERT INTO email_log (student_id, to_email, status, sent_at) VALUES (?, ?, ?, ?)'
    ).run(studentId, 'family@example.test', 'failed', Date.now());

    const markerPhoto = await db.prepare(
      `INSERT INTO photos (batch_id, file, original, seq_index, qr_value, is_marker, hidden, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)`
    ).run(batchId, `${suffix}-following.jpg`, 'following.jpg', 1, null, Date.now());
    const project = await db.prepare(
      'INSERT INTO projects (name, created_at) VALUES (?, ?)'
    ).run(`Winter ${suffix}`, Date.now());
    projectId = project.lastInsertRowid;
    const projectQr = `PD-P${projectId}-${suffix.slice(0, 12).toUpperCase()}`;
    const projectGalleryToken = crypto.randomBytes(24).toString('base64url');
    await db.prepare(
      `INSERT INTO project_students (project_id, student_id, qr_code, gallery_token, expires_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(projectId, galleryStudentId, projectQr, projectGalleryToken, Date.now() + 86400000, Date.now());
    projectBatchId = (await db.prepare(
      'INSERT INTO batches (name, project_id, created_at) VALUES (?, ?, ?)'
    ).run(`Project batch ${suffix}`, projectId, Date.now())).lastInsertRowid;
    await db.prepare(
      `INSERT INTO photos (batch_id, project_id, student_id, file, original, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(projectBatchId, projectId, galleryStudentId, `${suffix}-project.jpg`, 'project.jpg', Date.now());
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
    const persistedGallery = await galleryStudentByToken(db, galleryToken);
    assert.equal(persistedGallery.student.id, galleryStudentId, 'published gallery is found after reconnect');
    assert.equal(persistedGallery.student.published_at > 0, true);
    assert.equal(persistedGallery.student.expires_at > Date.now(), true);
    assert.deepEqual(databaseModule.getSetting(settingKey), { marker: suffix }, 'settings load from MySQL');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM batches WHERE id = ?').get(batchId)).n, 1);
    assert.equal((await db.prepare('SELECT project_id FROM batches WHERE id = ?').get(batchId)).project_id, null);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE batch_id = ? AND student_id = ?').get(batchId, studentId)).n, 2);
    assert.equal((await db.prepare('SELECT project_id FROM photos WHERE id = ?').get(photoId)).project_id, null);
    assert.equal((await db.prepare('SELECT project_id FROM batches WHERE id = ?').get(projectBatchId)).project_id, projectId);
    assert.equal((await db.prepare('SELECT project_id FROM photos WHERE project_id = ? AND batch_id = ?').get(projectId, projectBatchId)).project_id, projectId);
    assert.equal((await db.prepare('SELECT qr_code FROM students WHERE id = ?').get(galleryStudentId)).qr_code, `PD-2026-IMPORT-${suffix}`);
    const projectGallery = await db.prepare(
      'SELECT gallery_token, published_at FROM project_students WHERE project_id = ? AND student_id = ?'
    ).get(projectId, galleryStudentId);
    assert.equal(projectGallery.gallery_token, projectGalleryToken);
    assert.ok(projectGallery.published_at);
    const sortedPhotos = await db.prepare(
      'SELECT student_id, is_marker, hidden, qr_value FROM photos WHERE batch_id = ? ORDER BY seq_index'
    ).all(batchId);
    assert.equal(sortedPhotos[0].student_id, studentId);
    assert.equal(sortedPhotos[0].is_marker, 1);
    assert.equal(sortedPhotos[0].hidden, 1);
    assert.equal(sortedPhotos[0].qr_value, qrCode);
    assert.equal(sortedPhotos[1].student_id, studentId);
    assert.equal((await db.prepare('SELECT sorted_at FROM batches WHERE id = ?').get(batchId)).sorted_at > 0, true);
    const emailAttempts = await db.prepare(
      `SELECT outcome, diagnostic_json, message_id FROM gallery_email_attempts
       WHERE student_id = ? ORDER BY id`
    ).all(studentId);
    assert.equal(emailAttempts.length, 2, 'legacy and diagnostic attempts persist');
    assert.equal(emailAttempts[0].outcome, null, 'legacy attempt remains compatible with nullable diagnostics');
    assert.equal(emailAttempts[1].outcome, 'rejected');
    assert.deepEqual(JSON.parse(emailAttempts[1].diagnostic_json), { outcome: 'rejected', smtpCode: 550 });
    assert.equal(emailAttempts[1].message_id, 'gateway-test-message-id');
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
    await db.prepare('DELETE FROM students WHERE id = ?').run(galleryStudentId);
    await db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(Date.now(), projectId);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM photos WHERE project_id = ?').get(projectId)).n, 1);
    await db.prepare('DELETE FROM batches WHERE id = ?').run(projectBatchId);
    await db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    await db.prepare('DELETE FROM users WHERE username = ?').run(username);
    await db.prepare('DELETE FROM settings WHERE `key` = ?').run(settingKey);
  } finally {
    if (db) await db.close().catch(() => {});
    fs.rmSync(assetRoot, { recursive: true, force: true });
  }
});
