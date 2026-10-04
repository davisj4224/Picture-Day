'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  publishStudentRecord,
  galleryStudentByToken,
  galleryStudentForEmail,
  galleryLink
} = require('../lib/gallery');

function fakeDatabase(initialStudent, { persistUpdates = true } = {}) {
  const state = { student: { ...initialStudent } };
  return {
    state,
    db: {
      prepare(sql) {
        return {
          async get(value) {
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
