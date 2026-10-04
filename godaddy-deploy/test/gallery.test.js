'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  publishStudentRecord,
  galleryStudentByToken,
  galleryTokenHealth,
  galleryStudentForEmail,
  galleryLink
} = require('../lib/gallery');

function fakeDatabase(initialStudent, { persistUpdates = true, photos = [] } = {}) {
  const state = { student: { ...initialStudent } };
  return {
    state,
    db: {
      prepare(sql) {
        return {
          async get(value) {
            if (sql.includes('FROM photos')) {
              return {
                photo_count: photos.filter((photo) =>
                  photo.student_id === Number(value) &&
                  photo.published === 1 &&
                  photo.hidden === 0 &&
                  photo.is_marker === 0
                ).length
              };
            }
            if (sql.includes('WHERE id = ?')) {
              return state.student?.id === Number(value) ? { ...state.student } : undefined;
            }
            if (sql.includes('WHERE gallery_token = ?')) {
              return state.student?.gallery_token === value ? { ...state.student } : undefined;
            }
            throw new Error(`Unexpected query: ${sql}`);
          },
          async run(token, expiresAt, publishedAt, id) {
            if (!sql.startsWith('UPDATE students SET gallery_token')) {
              throw new Error(`Unexpected update: ${sql}`);
            }
            if (!persistUpdates || state.student?.id !== Number(id)) return { changes: 0 };
            Object.assign(state.student, {
              gallery_token: token,
              expires_at: expiresAt,
              published_at: publishedAt
            });
            return { changes: 1 };
          }
        };
      }
    }
  };
}

test('publishing persists the emailed token and gallery lookup survives a new connection', async () => {
  const importedStudent = {
    id: 41,
    ext_id: 'roster-41',
    first_name: 'Imported',
    last_name: 'Student',
    gallery_token: null,
    published_at: null,
    expires_at: null
  };
  const { state, db } = fakeDatabase(importedStudent);
  const token = 'A'.repeat(32);
  const logs = [];

  const published = await publishStudentRecord(db, importedStudent.id, 45, () => token, {
    info: (message, details) => logs.push({ message, details })
  });
  assert.equal(published.gallery_token, token);
  assert.ok(published.published_at);
  assert.ok(published.expires_at > Date.now());
  assert.equal((await galleryStudentByToken(db, token)).student.id, importedStudent.id);
  assert.equal((await galleryStudentForEmail(db, importedStudent.id)).gallery_token, token);
  assert.equal(galleryLink(token, 'https://calcharterpicts.org/'), `https://calcharterpicts.org/g/${token}`);
  assert.throws(() => galleryLink(token, ''), /public gallery URL/);
  assert.equal(logs[0].details.tokenAction, 'generated');
  assert.equal(logs[0].details.expectedRowAffected, true);
  assert.equal(logs[0].details.tokenPersisted, true);
  assert.equal(JSON.stringify(logs).includes(token), false, 'diagnostic logs do not contain the token');

  const newConnection = fakeDatabase(state.student).db;
  const afterRestart = await galleryStudentByToken(newConnection, token);
  assert.equal(afterRestart.student.gallery_token, token);
  assert.equal(afterRestart.student.published_at, published.published_at);
  assert.equal(afterRestart.student.expires_at, published.expires_at);
});

test('publishing reuses a valid token and rejects an update that did not persist publication state', async () => {
  const existing = {
    id: 9,
    gallery_token: 'B'.repeat(32),
    published_at: 1,
    expires_at: 2
  };
  const reused = fakeDatabase(existing);
  let generated = false;
  const result = await publishStudentRecord(reused.db, existing.id, 45, () => {
    generated = true;
    return 'unexpected-new-token';
  }, { info() {} });
  assert.equal(generated, false);
  assert.equal(result.gallery_token, existing.gallery_token);

  const invalid = fakeDatabase({ id: 11, gallery_token: 'broken', published_at: null, expires_at: null });
  const repaired = await publishStudentRecord(invalid.db, 11, 45, () => 'F'.repeat(32), { info() {} });
  assert.equal(repaired.gallery_token, 'F'.repeat(32));

  const notPersisted = fakeDatabase({ id: 10, gallery_token: null, published_at: null, expires_at: null }, {
    persistUpdates: false
  });
  await assert.rejects(
    publishStudentRecord(notPersisted.db, 10, 45, () => 'C'.repeat(32), { info() {} }),
    /not persisted to MySQL/
  );
});

test('email and gallery lookup reject unpublished or expired records', async () => {
  const unpublished = fakeDatabase({
    id: 15,
    gallery_token: 'D'.repeat(32),
    published_at: null,
    expires_at: Date.now() + 60_000
  });
  assert.equal((await galleryStudentByToken(unpublished.db, 'D'.repeat(32))).status, 'not-found');
  await assert.rejects(galleryStudentForEmail(unpublished.db, 15), { code: 'GALLERY_NOT_PUBLISHED' });

  const expired = fakeDatabase({
    id: 16,
    gallery_token: 'E'.repeat(32),
    published_at: 1,
    expires_at: 1
  });
  assert.equal((await galleryStudentByToken(expired.db, 'E'.repeat(32))).status, 'expired');
  await assert.rejects(galleryStudentForEmail(expired.db, 16), { code: 'GALLERY_EXPIRED' });
});

test('staff gallery-token health diagnostics distinguish all states without private fields', async () => {
  const now = Date.now();
  const cases = [
    {
      name: 'not found',
      student: null,
      expected: {
        found: false,
        published: false,
        hasToken: false,
        hasPublishedAt: false,
        hasExpiresAt: false,
        expired: false,
        photoCount: 0
      }
    },
    {
      name: 'found but unpublished',
      student: { id: 1, gallery_token: 'A'.repeat(32), published_at: null, expires_at: null },
      expected: {
        found: true,
        published: false,
        hasToken: true,
        hasPublishedAt: false,
        hasExpiresAt: false,
        expired: false,
        photoCount: 1
      }
    },
    {
      name: 'published but expired',
      student: { id: 2, gallery_token: 'B'.repeat(32), published_at: now - 2000, expires_at: now - 1000 },
      expected: {
        found: true,
        published: true,
        hasToken: true,
        hasPublishedAt: true,
        hasExpiresAt: true,
        expired: true,
        photoCount: 1
      }
    },
    {
      name: 'published and unexpired',
      student: { id: 3, gallery_token: 'C'.repeat(32), published_at: now - 1000, expires_at: now + 60_000 },
      expected: {
        found: true,
        published: true,
        hasToken: true,
        hasPublishedAt: true,
        hasExpiresAt: true,
        expired: false,
        photoCount: 1
      }
    }
  ];

  for (const entry of cases) {
    const { db } = fakeDatabase(entry.student, {
      photos: [
        { student_id: entry.student?.id, published: 1, hidden: 0, is_marker: 0 },
        { student_id: entry.student?.id, published: 0, hidden: 0, is_marker: 0 },
        { student_id: entry.student?.id, published: 1, hidden: 1, is_marker: 0 },
        { student_id: entry.student?.id, published: 1, hidden: 0, is_marker: 1 }
      ]
    });
    const result = await galleryTokenHealth(db, entry.student?.gallery_token || 'missing-token', now);
    assert.deepEqual(result, entry.expected, entry.name);
    assert.deepEqual(Object.keys(result).sort(), [
      'expired',
      'found',
      'hasExpiresAt',
      'hasPublishedAt',
      'hasToken',
      'photoCount',
      'published'
    ]);
    assert.equal(JSON.stringify(result).includes(entry.student?.gallery_token || 'missing-token'), false);
    assert.equal('id' in result, false);
    assert.equal('first_name' in result, false);
    assert.equal('parent_email' in result, false);
  }
});

test('gallery-token health route requires staff authentication', () => {
  const serverSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(
    serverSource,
    /app\.get\(\s*'\/api\/admin\/gallery-token-health\/:token',\s*requireStaff,\s*ok\(/
  );
});
