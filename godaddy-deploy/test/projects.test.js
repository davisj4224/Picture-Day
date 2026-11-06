'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  resolveProjectQr,
  publishProjectStudent,
  unpublishProjectStudent,
  projectGalleryStudentByToken,
  projectGalleryPhotos
} = require('../lib/projects');

const appRoot = path.join(__dirname, '..');
const schemaSource = fs.readFileSync(path.join(appRoot, 'lib', 'db.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(appRoot, 'server.js'), 'utf8');

test('project schema is additive, repeatable, and leaves historical associations null', () => {
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS projects\b/);
  assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS project_students\b/);
  assert.match(schemaSource, /\[\['batches', 'project_id'\], \['photos', 'project_id'\]\]/);
  assert.match(schemaSource, /ADD COLUMN.*BIGINT UNSIGNED NULL/);
  assert.match(schemaSource, /ON DELETE SET NULL/);
  assert.doesNotMatch(schemaSource, /UPDATE\s+(batches|photos)\s+SET\s+project_id/i);
});

test('existing student QR codes resolve in any selected project without project QR mappings', () => {
  const studentCodes = new Map([['PD-2026-LEGACY', 21]]);
  const projectCodes = new Map();
  assert.deepEqual(resolveProjectQr('PD-2026-LEGACY', projectCodes, studentCodes), { studentId: 21, source: 'legacy' });
  assert.deepEqual(resolveProjectQr('PD-2026-LEGACY', projectCodes, studentCodes), { studentId: 21, source: 'legacy' });
  assert.equal(studentCodes.get('PD-2026-LEGACY'), 21);
});

test("project-specific QR codes resolve only within their project's lookup", () => {
  const projectThreeCodes = new Map([['PD-P3-ABC23456789Q', 21]]);
  const projectFourCodes = new Map();
  const studentCodes = new Map();
  assert.deepEqual(resolveProjectQr('PD-P3-ABC23456789Q', projectThreeCodes, studentCodes), {
    studentId: 21,
    source: 'project'
  });
  assert.equal(resolveProjectQr('PD-P3-ABC23456789Q', projectFourCodes, studentCodes), null);
});

test('project gallery publication and unpublication are isolated from other projects and legacy photos', async () => {
  const memberships = new Map([
    ['4:21', { project_id: 4, student_id: 21, gallery_token: null, published_at: null, expires_at: null }],
    ['5:21', { project_id: 5, student_id: 21, gallery_token: 'B'.repeat(32), published_at: 1, expires_at: 2 }]
  ]);
  const photos = [
    { project_id: 4, student_id: 21, published: 0 },
    { project_id: 5, student_id: 21, published: 1 },
    { project_id: null, student_id: 21, published: 1 }
  ];
  const db = {
    prepare(sql) {
      return {
        async get(...params) {
          if (sql.includes('FROM projects')) return { id: params[0], archived_at: null };
          if (sql.includes('FROM students')) return { id: params[0] };
          if (sql.includes('SELECT gallery_token FROM project_students')) return memberships.get(`${params[0]}:${params[1]}`);
          if (sql.includes('SELECT gallery_token, expires_at, published_at')) return memberships.get(`${params[0]}:${params[1]}`);
          throw new Error(`Unexpected query: ${sql}`);
        },
        async run(...params) {
          if (sql.includes('INSERT INTO project_students')) {
            const [projectId, studentId] = params;
            memberships.set(`${projectId}:${studentId}`, memberships.get(`${projectId}:${studentId}`) || {
              project_id: projectId, student_id: studentId, gallery_token: null, published_at: null, expires_at: null
            });
          } else if (sql.startsWith('UPDATE project_students SET gallery_token')) {
            const [galleryToken, expiresAt, publishedAt, projectId, studentId] = params;
            Object.assign(memberships.get(`${projectId}:${studentId}`), {
              gallery_token: galleryToken, expires_at: expiresAt, published_at: publishedAt
            });
          } else if (sql.startsWith('UPDATE photos SET published = 1')) {
            for (const photo of photos) {
              if (photo.project_id === params[0] && photo.student_id === params[1]) photo.published = 1;
            }
          } else if (sql.startsWith('UPDATE project_students SET published_at = NULL')) {
            const row = memberships.get(`${params[0]}:${params[1]}`);
            if (row) row.published_at = null;
          } else if (sql.startsWith('UPDATE photos SET published = 0')) {
            for (const photo of photos) {
              if (photo.project_id === params[0] && photo.student_id === params[1]) photo.published = 0;
            }
          } else {
            throw new Error(`Unexpected update: ${sql}`);
          }
          return { changes: 1 };
        }
      };
    }
  };
  const generatedToken = 'A'.repeat(32);
  const published = await publishProjectStudent(db, 4, 21, 45, () => generatedToken);
  assert.equal(published.token, generatedToken);
  assert.equal(photos[0].published, 1);
  assert.equal(photos[1].published, 1);
  assert.equal(photos[2].published, 1);
  await unpublishProjectStudent(db, 4, 21);
  assert.equal(memberships.get('4:21').published_at, null);
  assert.equal(photos[0].published, 0);
  assert.equal(memberships.get('5:21').published_at, 1);
  assert.equal(photos[1].published, 1);
  assert.equal(photos[2].published, 1);
});

test('archived projects retain data and reject new gallery publication', async () => {
  const project = { id: 8, archived_at: Date.now() };
  let insertedMembership = false;
  const db = {
    prepare(sql) {
      return {
        async get() {
          if (sql.includes('FROM projects')) return project;
          throw new Error(`Unexpected query: ${sql}`);
        },
        async run() {
          insertedMembership = true;
          return { changes: 1 };
        }
      };
    }
  };
  const result = await publishProjectStudent(db, 8, 21, 45, () => 'D'.repeat(32));
  assert.equal(result.status, 'archived');
  assert.equal(insertedMembership, false);
  assert.match(serverSource, /UPDATE projects SET archived_at = COALESCE\(archived_at, \?\)/);
});

test('project gallery token lookup and photo lists are scoped to that project and student', async () => {
  const token = 'C'.repeat(32);
  const photos = [
    { id: 1, project_id: 4, student_id: 21, published: 1, hidden: 0, is_marker: 0 },
    { id: 2, project_id: 5, student_id: 21, published: 1, hidden: 0, is_marker: 0 },
    { id: 3, project_id: 4, student_id: 22, published: 1, hidden: 0, is_marker: 0 },
    { id: 4, project_id: 4, student_id: 21, published: 0, hidden: 0, is_marker: 0 }
  ];
  const db = {
    prepare(sql) {
      return {
        async get(value) {
          if (sql.includes('FROM project_students ps')) {
            return value === token
              ? {
                  project_id: 4, student_id: 21, gallery_token: token,
                  expires_at: Date.now() + 60_000, published_at: Date.now(),
                  archived_at: Date.now(),
                  project_name: 'Fall', first_name: 'Sam', last_name: 'Student'
                }
              : undefined;
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
        async all(projectId, studentId) {
          if (!sql.includes('FROM photos')) throw new Error(`Unexpected query: ${sql}`);
          return photos.filter((photo) =>
            photo.project_id === projectId &&
            photo.student_id === studentId &&
            photo.published === 1 &&
            photo.hidden === 0 &&
            photo.is_marker === 0
          );
        }
      };
    }
  };
  const gallery = await projectGalleryStudentByToken(db, token);
  assert.equal(gallery.student.project_name, 'Fall');
  assert.ok(gallery.student.archived_at, 'archiving does not invalidate a published gallery link');
  const visiblePhotos = await projectGalleryPhotos(db, gallery.student.project_id, gallery.student.student_id);
  assert.deepEqual(visiblePhotos.map((photo) => photo.id), [1]);
  assert.equal((await projectGalleryStudentByToken(db, 'missing')).status, 'not-found');
});

test('project routes require selected project batches and preserve legacy gallery endpoints', () => {
  assert.match(serverSource, /INSERT INTO batches \(name, project_id, created_at\)/);
  assert.match(serverSource, /INSERT INTO photos \(batch_id, project_id,[\s\S]*?SELECT b\.id, b\.project_id/);
  assert.match(serverSource, /resolveProjectQr\(code, projectCodes, byCode\)/);
  assert.match(serverSource, /app\.get\(\s*'\/api\/gallery\/:token'/);
  assert.match(serverSource, /app\.get\('\/api\/projects\/gallery\/:token'/);
  assert.match(serverSource, /UPDATE projects SET archived_at = COALESCE\(archived_at, \?\)/);
  assert.match(serverSource, /UPDATE photos SET published = 0 WHERE student_id = \? AND project_id IS NULL/);
});
