'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { parse: parseCsv } = require('csv-parse/sync');

const { db, initialize, config, branding, setSetting, newQrCode, newGalleryToken, DEFAULT_BRANDING } = require('./lib/db.js');
const cards = require('./lib/cards.js');
const mail = require('./lib/mail.js');
const {
  publishStudentRecord,
  galleryStudentByToken,
  galleryStudentForEmail,
  galleryLink: buildGalleryLink
} = require('./lib/gallery.js');



const app = express();
const PORT = Number(process.env.PORT || 3000);

/*
 * Persistent MySQL-backed session store.
 * This keeps staff sessions across Node process restarts.
 */
class MySqlSessionStore extends session.Store {
  get(sid, callback) {
    db.prepare('SELECT sess, expires_at FROM sessions WHERE sid = ?').get(sid).then(async (row) => {
      if (!row) return callback(null, null);
      if (row.expires_at && row.expires_at <= Date.now()) {
        await db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    }).catch(callback);
  }

  set(sid, sess, callback) {
    Promise.resolve().then(async () => {
      const expiresAt = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : null;
      await db.prepare(`
        INSERT INTO sessions (sid, sess, expires_at)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE sess = VALUES(sess), expires_at = VALUES(expires_at)
      `).run(sid, JSON.stringify(sess), expiresAt);
    }).then(() => callback?.(null), (error) => callback?.(error));
  }

  destroy(sid, callback) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid)
      .then(() => callback?.(null), (error) => callback?.(error));
  }

  touch(sid, sess, callback) {
    Promise.resolve().then(async () => {
      const expiresAt = sess.cookie?.expires
        ? new Date(sess.cookie.expires).getTime()
        : null;
      await db.prepare(
        'UPDATE sessions SET expires_at = ? WHERE sid = ?'
      ).run(expiresAt, sid);
    }).then(() => callback?.(null), (error) => callback?.(error));
  }

  clear(callback) {
    db.prepare('DELETE FROM sessions').run()
      .then(() => callback?.(null), (error) => callback?.(error));
  }
}
const ROOT = __dirname;
const VIEWS = path.join(ROOT, 'views');
const ASSET_ROOT = path.resolve(process.env.PICTUREDAY_ASSET_DIR || path.join(ROOT, 'public', 'assets', 'pictureday'));
const UP_FULL = path.join(ASSET_ROOT, 'full');
const UP_THUMB = path.join(ASSET_ROOT, 'thumb');
const UP_BRAND = path.join(ASSET_ROOT, 'brand');
[UP_FULL, UP_THUMB, UP_BRAND].forEach((d) => fs.mkdirSync(d, { recursive: true }));

/* ------------------------------------------------------------ middleware */

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET must be configured before starting the application.');

app.use(
  session({
    store: new MySqlSessionStore(),
    name: 'pd.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: String(process.env.SECURE_COOKIES || 'false') === 'true',
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

// CSRF: every state-changing API call must echo the session token.
app.use((req, res, next) => {
  if (req.session && !req.session.csrf) req.session.csrf = crypto.randomBytes(18).toString('base64url');
  const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  const open = req.path === '/api/login' || req.path === '/api/setup';
  if (safe || open) return next();
  if (req.get('x-csrf-token') && req.get('x-csrf-token') === req.session.csrf) return next();
  return res.status(403).json({ error: 'Your session expired. Reload the page and sign in again.' });
});

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait ten minutes and try again.' }
});

const galleryLimiter = rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false });

function userCount() {
  return db.prepare('SELECT COUNT(*) n FROM users').get().then((row) => Number(row.n));
}
const isStaff = (req) => ['staff', 'admin'].includes(req.session?.user?.role);
const isAdmin = (req) => req.session?.user?.role === 'admin';
const isSignedIn = (req) => Boolean(req.session?.user);

function requireStaff(req, res, next) {
  if (!isStaff(req)) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in as staff to do that.' });
    return res.redirect('/login');
  }
  if (req.session.user.mustChangePassword) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Please change your temporary password first.' });
    return res.redirect('/change-password');
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Administrator access is required.' });
  return res.redirect('/login');
}
function requireUser(req, res, next) {
  if (isSignedIn(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in first.' });
  return res.redirect('/login');
}

const ok = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------------------------------------------------------------- pages */

const page = (name) => (req, res) => res.sendFile(path.join(VIEWS, name));

app.get('/', ok(async (req, res, next) => {
  if (await userCount() === 0) return res.sendFile(path.join(VIEWS, 'setup.html'));
  return page('index.html')(req, res, next);
}));
app.get('/setup', ok(async (req, res) => {
  if (await userCount() > 0) return res.redirect('/login');
  return res.sendFile(path.join(VIEWS, 'setup.html'));
}));
app.get('/login', ok(async (req, res) => {
  if (await userCount() === 0) return res.redirect('/setup');
  return res.sendFile(path.join(VIEWS, 'login.html'));
}));
app.get('/admin', requireStaff, page('admin.html'));
app.get('/change-password', requireUser, page('change-password.html'));
app.get('/design', requireUser, page('design.html'));
app.get('/g/:token', page('gallery.html'));

app.use((req, res, next) => {
  if (/^\/assets\/pictureday\/(?:full|thumb)(?:\/|$)/.test(req.path)) return res.sendStatus(404);
  next();
});
app.use('/assets', express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));

/* ----------------------------------------------------------------- auth */

app.post(
  '/api/setup',
  loginLimiter,
  ok(async (req, res) => {
    if (await userCount() > 0) return res.status(403).json({ error: 'Setup has already been completed.' });
    const { username, password, designPassword, schoolName } = req.body || {};
    if (!username || !password || password.length < 10)
      return res.status(400).json({ error: 'Staff password must be at least 10 characters.' });
    const now = Date.now();
    const ins = db.prepare('INSERT INTO users (username, password, role, created_at) VALUES (?,?,?,?)');
    await ins.run(String(username).trim().toLowerCase(), bcrypt.hashSync(password, 12), 'admin', now);
    if (designPassword && designPassword.length >= 6)
      await ins.run('design', bcrypt.hashSync(designPassword, 12), 'designer', now);
    if (schoolName) {
      const b = { ...DEFAULT_BRANDING, schoolName };
      await setSetting('branding_draft', b);
      await setSetting('branding_published', b);
    }
    res.json({ ok: true });
  })
);

app.post(
  '/api/login',
  loginLimiter,
  ok(async (req, res) => {
    const { username, password } = req.body || {};
    const row = await db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
    if (!row || !bcrypt.compareSync(String(password || ''), row.password))
      return res.status(401).json({ error: 'That username and password do not match.' });
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Could not start a session.' });
      req.session.user = { id: row.id, username: row.username, role: row.role, mustChangePassword: Boolean(row.must_change_password) };
      req.session.csrf = crypto.randomBytes(18).toString('base64url');
      res.json({ ok: true, user: req.session.user, csrf: req.session.csrf });
    });
  })
);

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) =>
  res.json({
    user: req.session.user || null,
    csrf: req.session.csrf,
    emailConfigured: mail.configured(),
    config: isStaff(req) ? config() : undefined
  })
);

app.post(
  '/api/password',
  requireUser,
  ok(async (req, res) => {
    const { current, next: nextPw } = req.body || {};
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!row || !bcrypt.compareSync(String(current || ''), row.password))
      return res.status(401).json({ error: 'Current password is not right.' });
    if (!nextPw || nextPw.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
    await db.prepare('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(nextPw, 12), row.id);
    req.session.user.mustChangePassword = false;
    res.json({ ok: true, user: req.session.user, csrf: req.session.csrf });
  })
);

app.get('/api/staff-users', requireAdmin, ok(async (req, res) => {
  const users = await db.prepare("SELECT id, username FROM users WHERE role = 'staff' ORDER BY username").all();
  res.json(users);
}));

app.get('/api/admin/database-health', requireAdmin, ok(async (req, res) => {
  await db.ping();
  const tables = await db.tableReadiness();
  res.status(tables.ready ? 200 : 503).json({ database: 'connected', schemaReady: tables.ready, tables });
}));

app.post(
  '/api/staff-users',
  requireAdmin,
  ok(async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–32 characters: letters, numbers, dots, hyphens, or underscores.' });
    }
    if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    if (Number((await db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'staff'").get()).n) >= 5) {
      return res.status(400).json({ error: 'The limit of 5 staff accounts has been reached.' });
    }
    if (await db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'That username is already in use.' });
    }
    const result = await db
      .prepare('INSERT INTO users (username, password, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?)')
.run(username, bcrypt.hashSync(password, 12), 'staff', 1, Date.now());
    res.status(201).json({ id: result.lastInsertRowid, username });
  })
);

app.delete(
  '/api/staff-users/:id',
  requireAdmin,
  ok(async (req, res) => {
    const user = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'staff'").get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Staff account not found.' });
    if (user.id === req.session.user.id) return res.status(400).json({ error: 'You cannot remove your own account.' });
    if (Number((await db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'staff'").get()).n) <= 1) {
      return res.status(400).json({ error: 'At least one staff account must remain.' });
    }
    await db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.json({ ok: true });
  })
);

/* -------------------------------------------------------------- settings */

app.get('/api/config', requireStaff, (req, res) => res.json(config()));

app.put(
  '/api/config',
  requireStaff,
  ok(async (req, res) => {
    const merged = { ...config(), ...(req.body || {}) };
    merged.galleryDays = Math.max(1, Math.min(365, Number(merged.galleryDays) || 45));
    merged.minPhotos = Math.max(1, Math.min(20, Number(merged.minPhotos) || 2));
    await setSetting('config', merged);
    res.json(merged);
  })
);

/* -------------------------------------------------------------- students */

const studentPublic = (s) => ({
  id: s.id,
  extId: s.ext_id,
  firstName: s.first_name,
  lastName: s.last_name,
  grade: s.grade,
  teacher: s.teacher,
  parentEmail: s.parent_email,
  parentName: s.parent_name,
  qrCode: s.qr_code,
  galleryToken: s.gallery_token,
  expiresAt: s.expires_at,
  publishedAt: s.published_at,
  notes: s.notes,
  active: !!s.active,
  photoCount: s.photo_count || 0,
  emailedAt: s.emailed_at || null
});

const ROSTER_SQL = `
  SELECT s.*,
    (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0) AS photo_count,
    (SELECT MAX(sent_at) FROM email_log e WHERE e.student_id = s.id AND e.status = 'sent') AS emailed_at
  FROM students s`;

app.get('/api/students', requireStaff, ok(async (req, res) => {
  const rows = await db.prepare(`${ROSTER_SQL} ORDER BY s.last_name, s.first_name`).all();
  res.json(rows.map(studentPublic));
}));

function cleanStudent(body) {
  const t = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
  return {
    ext_id: t(body.extId),
    first_name: t(body.firstName),
    last_name: t(body.lastName),
    grade: t(body.grade),
    teacher: t(body.teacher),
    parent_email: t(body.parentEmail),
    parent_name: t(body.parentName),
    notes: t(body.notes)
  };
}

app.post(
  '/api/students',
  requireStaff,
  ok(async (req, res) => {
    const s = cleanStudent(req.body || {});
    if (!s.first_name || !s.last_name) return res.status(400).json({ error: 'First and last name are required.' });
    const info = await db
      .prepare(
        `INSERT INTO students (ext_id, first_name, last_name, grade, teacher, parent_email, parent_name, notes, qr_code, created_at)
         VALUES (@ext_id, @first_name, @last_name, @grade, @teacher, @parent_email, @parent_name, @notes, @qr, @now)`
      )
      .run({ ...s, qr: await newQrCode(), now: Date.now() });
    res.json(studentPublic(await db.prepare(`${ROSTER_SQL} WHERE s.id = ?`).get(info.lastInsertRowid)));
  })
);

app.put(
  '/api/students/:id',
  requireStaff,
  ok(async (req, res) => {
    const s = cleanStudent(req.body || {});
    const exists = await db.prepare('SELECT 1 FROM students WHERE id = ?').get(req.params.id);
    if (!exists) return res.status(404).json({ error: 'No such student.' });
    await db.prepare(
      `UPDATE students SET ext_id=@ext_id, first_name=@first_name, last_name=@last_name, grade=@grade,
       teacher=@teacher, parent_email=@parent_email, parent_name=@parent_name, notes=@notes,
       active=@active WHERE id=@id`
    ).run({ ...s, active: req.body.active === false ? 0 : 1, id: req.params.id });
    res.json(studentPublic(await db.prepare(`${ROSTER_SQL} WHERE s.id = ?`).get(req.params.id)));
  })
);

app.delete(
  '/api/students/:id',
  requireStaff,
  ok(async (req, res) => {
    await db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

// Fresh QR code for a student whose card was lost or damaged.
app.post(
  '/api/students/:id/recode',
  requireStaff,
  ok(async (req, res) => {
    await db.prepare('UPDATE students SET qr_code = ? WHERE id = ?').run(await newQrCode(), req.params.id);
    res.json(studentPublic(await db.prepare(`${ROSTER_SQL} WHERE s.id = ?`).get(req.params.id)));
  })
);

const HEADER_MAP = {
  'student id': 'extId', 'studentid': 'extId', 'id': 'extId', 'ext id': 'extId',
  'first name': 'firstName', 'firstname': 'firstName', 'first': 'firstName', 'given name': 'firstName',
  'last name': 'lastName', 'lastname': 'lastName', 'last': 'lastName', 'surname': 'lastName', 'family name': 'lastName',
  'name': 'fullName', 'student name': 'fullName', 'student': 'fullName',
  'grade': 'grade', 'grade level': 'grade', 'year': 'grade',
  'teacher': 'teacher', 'homeroom': 'teacher', 'class': 'teacher', 'teacher name': 'teacher',
  'email': 'parentEmail', 'parent email': 'parentEmail', 'guardian email': 'parentEmail',
  'parent/guardian email': 'parentEmail', 'contact email': 'parentEmail',
  'parent': 'parentName', 'parent name': 'parentName', 'guardian': 'parentName', 'guardian name': 'parentName',
  'notes': 'notes'
};

app.post(
  '/api/students/import',
  requireStaff,
  ok(async (req, res) => {
    const text = String(req.body?.csv || '');
    if (!text.trim()) return res.status(400).json({ error: 'The file looked empty.' });
    let rows;
    try {
      rows = parseCsv(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch (e) {
      return res.status(400).json({ error: `Could not read that CSV: ${e.message}` });
    }

    const mode = req.body.mode === 'replace' ? 'replace' : 'add';
    const result = { added: 0, updated: 0, skipped: [], total: rows.length };

    await db.transaction(async (tx) => {
      const insert = tx.prepare(
        `INSERT INTO students (ext_id, first_name, last_name, grade, teacher, parent_email, parent_name, notes, qr_code, created_at)
         VALUES (@extId, @firstName, @lastName, @grade, @teacher, @parentEmail, @parentName, @notes, @qr, @now)`
      );
      const updateByExt = tx.prepare(
        `UPDATE students SET first_name=@firstName, last_name=@lastName, grade=@grade, teacher=@teacher,
         parent_email=@parentEmail, parent_name=@parentName, notes=@notes, active=1 WHERE id=@id`
      );
      if (mode === 'replace') await tx.prepare('UPDATE students SET active = 0').run();

      for (const [i, raw] of rows.entries()) {
        const rec = {};
        for (const [k, v] of Object.entries(raw)) {
          const key = HEADER_MAP[String(k).trim().toLowerCase()];
          if (key) rec[key] = String(v ?? '').trim();
        }
        if (rec.fullName && !rec.firstName && !rec.lastName) {
          if (rec.fullName.includes(',')) {
            const [last, first] = rec.fullName.split(',');
            rec.lastName = last.trim();
            rec.firstName = (first || '').trim();
          } else {
            const parts = rec.fullName.split(/\s+/);
            rec.firstName = parts.shift() || '';
            rec.lastName = parts.join(' ');
          }
        }
        if (!rec.firstName || !rec.lastName) {
          result.skipped.push({ line: i + 2, why: 'no name found' });
          continue;
        }
        const payload = {
          extId: rec.extId || null,
          firstName: rec.firstName,
          lastName: rec.lastName,
          grade: rec.grade || null,
          teacher: rec.teacher || null,
          parentEmail: rec.parentEmail || null,
          parentName: rec.parentName || null,
          notes: rec.notes || null
        };

        const existing = payload.extId
          ? await tx.prepare('SELECT id FROM students WHERE ext_id = ?').get(payload.extId)
          : await tx
              .prepare('SELECT id FROM students WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?)')
              .get(payload.firstName, payload.lastName);

        if (existing) {
          await updateByExt.run({ ...payload, id: existing.id });
          result.updated++;
        } else {
          await insert.run({ ...payload, qr: await newQrCode(), now: Date.now() });
          result.added++;
        }
      }
    });
    res.json(result);
  })
);

/* -------------------------------------------------------------- QR codes */

app.get(
  '/api/students/:id/qr.png',
  requireStaff,
  ok(async (req, res) => {
    const s = await db.prepare('SELECT qr_code FROM students WHERE id = ?').get(req.params.id);
    if (!s) return res.sendStatus(404);
    const buf = await QRCode.toBuffer(s.qr_code, { errorCorrectionLevel: 'H', margin: 1, width: 512 });
    res.type('png').send(buf);
  })
);

app.get(
  '/api/cards.pdf',
  requireStaff,
  ok(async (req, res) => {
    const { grade, teacher, ids } = req.query;
    let sql = 'SELECT * FROM students WHERE active = 1';
    const params = [];
    if (grade) { sql += ' AND grade = ?'; params.push(grade); }
    if (teacher) { sql += ' AND teacher = ?'; params.push(teacher); }
    if (ids) {
      const list = String(ids).split(',').map((n) => Number(n)).filter(Boolean);
      if (list.length) { sql += ` AND id IN (${list.map(() => '?').join(',')})`; params.push(...list); }
    }
    sql += ' ORDER BY grade, teacher, last_name, first_name';
    const students = await db.prepare(sql).all(...params);
    const b = branding('published');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="qr-cards.pdf"');
    await cards.streamCards(students, { schoolName: b.schoolName, eventName: b.eventName, year: b.year }, res);
  })
);

/* --------------------------------------------------------------- uploads */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, file.fieldname === 'thumb' ? UP_THUMB : UP_FULL),
  filename: (req, file, cb) => {
    if (!req._pdName) req._pdName = crypto.randomBytes(12).toString('hex');
    const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase().slice(0, 6);
    cb(null, req._pdName + (file.fieldname === 'thumb' ? '.jpg' : ext));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 60 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) =>
    /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error('Only image files can be uploaded.'))
});

app.post(
  '/api/batches',
  requireStaff,
  ok(async (req, res) => {
    const name = String(req.body?.name || '').trim() || new Date().toLocaleString();
    const info = await db.prepare('INSERT INTO batches (name, created_at) VALUES (?, ?)').run(name, Date.now());
    res.json({ id: info.lastInsertRowid, name });
  })
);

app.get('/api/batches', requireStaff, ok(async (req, res) =>
  res.json(
    await db
      .prepare(
        `SELECT b.*, (SELECT COUNT(*) FROM photos p WHERE p.batch_id = b.id) AS photos
         FROM batches b ORDER BY b.created_at DESC`
      )
      .all()
  )
));

function photoFilePath(directory, filename) {
  const basename = path.basename(filename || '');
  if (!basename || basename !== filename) throw new Error('Invalid stored photo filename.');
  return path.join(directory, basename);
}

async function removePhotoFiles(photos) {
  for (const photo of photos) {
    await fs.promises.rm(photoFilePath(UP_FULL, photo.file), { force: true });
    if (photo.thumb) await fs.promises.rm(photoFilePath(UP_THUMB, photo.thumb), { force: true });
  }
}

app.delete(
  '/api/batches/:id',
  requireStaff,
  ok(async (req, res) => {
    const batchId = Number(req.params.id);
    if (!Number.isSafeInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch ID.' });
    const batch = await db.prepare('SELECT id FROM batches WHERE id = ?').get(batchId);
    if (!batch) return res.status(404).json({ error: 'Batch not found.' });

    const photos = await db.prepare('SELECT file, thumb FROM photos WHERE batch_id = ?').all(batchId);
    await db.prepare('DELETE FROM batches WHERE id = ?').run(batchId);
    await removePhotoFiles(photos);
    res.json({ ok: true, deletedPhotos: photos.length });
  })
);

app.post(
  '/api/upload',
  requireStaff,
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
  ok(async (req, res) => {
    const f = req.files?.file?.[0];
    if (!f) return res.status(400).json({ error: 'No photo was received.' });
    const thumb = req.files?.thumb?.[0];
    const info = await db
      .prepare(
        `INSERT INTO photos (batch_id, file, thumb, original, bytes, captured_at, seq_index, qr_value, created_at)
         VALUES (@batch, @file, @thumb, @original, @bytes, @captured, @seq, @qr, @now)`
      )
      .run({
        batch: Number(req.body.batchId) || null,
        file: f.filename,
        thumb: thumb ? thumb.filename : null,
        original: (f.originalname || '').slice(0, 200),
        bytes: f.size,
        captured: Number(req.body.capturedAt) || null,
        seq: Number(req.body.seq) || 0,
        qr: (req.body.qr || '').trim().slice(0, 200) || null,
        now: Date.now()
      });
    res.json({ id: info.lastInsertRowid });
  })
);

function normalizeCode(v) {
  if (!v) return null;
  let s = String(v).trim();
  const m = s.match(/([A-Za-z0-9]+-\d{4}-[A-Za-z0-9]{4,8})\s*$/);
  if (m) s = m[1];
  return s.toUpperCase();
}

async function sortBatch(batchId) {
  const students = await db.prepare('SELECT id, qr_code FROM students').all();
  const byCode = new Map(students.map((s) => [s.qr_code.toUpperCase(), s.id]));
  const photos = await db
    .prepare('SELECT * FROM photos WHERE batch_id = ? ORDER BY seq_index, id')
    .all(batchId);

  let current = null;
  const stats = { markers: 0, matched: 0, unmatched: 0, unknownCodes: [] };

  await db.transaction(async (tx) => {
    const setMarker = tx.prepare('UPDATE photos SET student_id=?, is_marker=1, hidden=1 WHERE id=?');
    const setPhoto = tx.prepare('UPDATE photos SET student_id=?, is_marker=0 WHERE id=?');
    for (const p of photos) {
      const code = normalizeCode(p.qr_value);
      if (code && byCode.has(code)) {
        current = byCode.get(code);
        await setMarker.run(current, p.id);
        stats.markers++;
        continue;
      }
      if (code && !byCode.has(code)) stats.unknownCodes.push(code);
      if (p.assigned_by === 'staff') continue; // hand-placed photos stay put
      await setPhoto.run(current, p.id);
      if (current) stats.matched++;
      else stats.unmatched++;
    }
    await tx.prepare('UPDATE batches SET sorted_at = ? WHERE id = ?').run(Date.now(), batchId);
  });

  stats.unknownCodes = [...new Set(stats.unknownCodes)];
  return stats;
}

app.post(
  '/api/batches/:id/sort',
  requireStaff,
  ok(async (req, res) => res.json(await sortBatch(Number(req.params.id))))
);

/* ---------------------------------------------------------------- photos */

const photoPublic = (p) => ({
  id: p.id,
  studentId: p.student_id,
  isMarker: !!p.is_marker,
  hidden: !!p.hidden,
  published: !!p.published,
  qrValue: p.qr_value,
  capturedAt: p.captured_at,
  original: p.original,
  batchId: p.batch_id,
  assignedBy: p.assigned_by,
  studentName: p.first_name ? `${p.first_name} ${p.last_name}` : null
});

app.get('/api/students/:id/photos', requireStaff, ok(async (req, res) =>
  res.json(
    (await db
      .prepare('SELECT * FROM photos WHERE student_id = ? ORDER BY COALESCE(captured_at,0), seq_index, id')
      .all(req.params.id))
      .map(photoPublic)
  )
));

app.get('/api/photos/unassigned', requireStaff, ok(async (req, res) =>
  res.json(
    (await db
      .prepare(
        `SELECT p.* FROM photos p WHERE p.student_id IS NULL AND p.is_marker = 0
         ORDER BY COALESCE(p.captured_at,0), p.seq_index, p.id LIMIT 500`
      )
      .all())
      .map(photoPublic)
  )
));

app.get('/api/photos/:id/file', requireStaff, ok(async (req, res) => {
  const p = await db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!p) return res.sendStatus(404);
  const thumb = req.query.size === 'thumb' && p.thumb;
  res.sendFile(path.join(thumb ? UP_THUMB : UP_FULL, thumb ? p.thumb : p.file), (error) => {
    if (error && !res.headersSent) res.sendStatus(error.code === 'ENOENT' ? 404 : 500);
  });
}));

app.post(
  '/api/photos/:id/assign',
  requireStaff,
  ok(async (req, res) => {
    const studentId = req.body?.studentId ? Number(req.body.studentId) : null;
    await db.prepare('UPDATE photos SET student_id = ?, assigned_by = ?, hidden = 0 WHERE id = ?').run(
      studentId,
      studentId ? 'staff' : null,
      req.params.id
    );
    res.json({ ok: true });
  })
);

app.post(
  '/api/photos/:id/hide',
  requireStaff,
  ok(async (req, res) => {
    await db.prepare('UPDATE photos SET hidden = ?, published = CASE WHEN ? THEN 0 ELSE published END WHERE id = ?').run(
      req.body?.hidden === false ? 0 : 1,
      req.body?.hidden === false ? 0 : 1,
      req.params.id
    );
    res.json({ ok: true });
  })
);

app.delete(
  '/api/photos/:id',
  requireStaff,
  ok(async (req, res) => {
    const p = await db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
    if (p) {
      await db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
      await removePhotoFiles([p]);
    }
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------- galleries */

async function publishStudent(id) {
  const cfg = config();
  const s = await publishStudentRecord(db, id, cfg.galleryDays, newGalleryToken);
  if (!s) return null;
  await db.prepare('UPDATE photos SET published = 1 WHERE student_id = ? AND is_marker = 0 AND hidden = 0').run(id);
  return db.prepare(`${ROSTER_SQL} WHERE s.id = ?`).get(id);
}

app.post(
  '/api/students/:id/publish',
  requireStaff,
  ok(async (req, res) => {
    const s = await publishStudent(Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'No such student.' });
    res.json(studentPublic(s));
  })
);

app.post(
  '/api/students/:id/unpublish',
  requireStaff,
  ok(async (req, res) => {
    await db.prepare('UPDATE students SET published_at = NULL WHERE id = ?').run(req.params.id);
    await db.prepare('UPDATE photos SET published = 0 WHERE student_id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

app.post(
  '/api/publish/ready',
  requireStaff,
  ok(async (req, res) => {
    const cfg = config();
    const rows = await db
      .prepare(
        `${ROSTER_SQL} WHERE s.active = 1 AND s.published_at IS NULL
         AND (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0) >= ?`
      )
      .all(cfg.minPhotos);
    for (const row of rows) await publishStudent(row.id);
    res.json({ published: rows.length });
  })
);

app.get(
  '/api/gallery/:token',
  galleryLimiter,
  ok(async (req, res) => {
    const gallery = await galleryStudentByToken(db, req.params.token);
    if (gallery.status === 'not-found') return res.status(404).json({ error: 'not-found' });
    if (gallery.status === 'expired') return res.status(410).json({ error: 'expired' });
    const s = gallery.student;
    const photos = await db
      .prepare(
        `SELECT id, captured_at FROM photos WHERE student_id = ? AND published = 1 AND hidden = 0 AND is_marker = 0
         ORDER BY COALESCE(captured_at,0), seq_index, id`
      )
      .all(s.id);
    const b = branding('published');
    res.json({
      student: { firstName: s.first_name, lastName: s.last_name, grade: s.grade, teacher: s.teacher },
      expiresAt: s.expires_at,
      photos: photos.map((p) => ({ id: p.id })),
      branding: b
    });
  })
);

app.get('/api/gallery/:token/photo/:id', galleryLimiter, ok(async (req, res) => {
  const gallery = await galleryStudentByToken(db, req.params.token);
  if (gallery.status === 'not-found') return res.sendStatus(404);
  if (gallery.status === 'expired') return res.sendStatus(410);
  const s = gallery.student;
  const p = await db
    .prepare('SELECT * FROM photos WHERE id = ? AND student_id = ? AND published = 1 AND hidden = 0')
    .get(req.params.id, s.id);
  if (!p) return res.sendStatus(404);
  const thumb = req.query.size === 'thumb' && p.thumb;
  if (req.query.download)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${s.last_name}-${s.first_name}-${p.id}${path.extname(p.file) || '.jpg'}"`
    );
  res.sendFile(path.join(thumb ? UP_THUMB : UP_FULL, thumb ? p.thumb : p.file), (error) => {
    if (error && !res.headersSent) res.sendStatus(error.code === 'ENOENT' ? 404 : 500);
  });
}));

/* ----------------------------------------------------------------- email */

function galleryLink(student) {
  const cfg = config();
  return buildGalleryLink(student.gallery_token, cfg.publicUrl);
}

function emailVars(s) {
  const b = branding('published');
  return {
    student: `${s.first_name} ${s.last_name}`,
    first: s.first_name,
    school: b.schoolName,
    event: b.eventName,
    year: b.year,
    link: galleryLink(s),
    expires: s.expires_at ? new Date(s.expires_at).toLocaleDateString() : ''
  };
}

function validRecipientEmail(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendGalleryEmail(studentId) {
  const student = await galleryStudentForEmail(db, studentId);
  const cfg = config();
  const palette = branding('published').palette;
  const recipient = String(student.parent_email || '').trim();
  const vars = emailVars(student);
  const attemptedAt = Date.now();
  const attempt = await db.prepare(
    `INSERT INTO gallery_email_attempts
      (student_id, recipient_email, email_type, attempted_at, status)
     VALUES (?, ?, 'gallery', ?, 'pending')`
  ).run(student.id, recipient, attemptedAt);

  try {
    await mail.send({
      to: recipient,
      from: cfg.emailFrom,
      replyTo: cfg.emailReplyTo,
      subject: mail.render(cfg.emailSubject, vars),
      text: mail.render(cfg.emailBody, vars),
      link: vars.link,
      palette
    });
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    await db.prepare('UPDATE gallery_email_attempts SET status = ?, error_message = ? WHERE id = ?')
      .run('failed', message, attempt.lastInsertRowid);
    throw error;
  }

  await db.prepare('UPDATE gallery_email_attempts SET status = ? WHERE id = ?')
    .run('sent', attempt.lastInsertRowid);
  return { attemptedAt, student };
}

app.get('/api/students/:id/email-history', requireStaff, ok(async (req, res) => {
  const student = await db.prepare(
    `SELECT parent_email, published_at,
      (gallery_token IS NOT NULL AND gallery_token <> '') AS has_gallery_token
     FROM students WHERE id = ?`
  ).get(req.params.id);
  if (!student) return res.status(404).json({ error: 'No such student.' });

  const attempts = await db.prepare(
    `SELECT id, recipient_email, email_type, attempted_at, status, error_message
     FROM gallery_email_attempts
     WHERE student_id = ? AND email_type = 'gallery'
     ORDER BY attempted_at DESC, id DESC LIMIT 10`
  ).all(req.params.id);

  res.json({
    published: Boolean(student.published_at && student.has_gallery_token),
    recipientEmail: String(student.parent_email || '').trim(),
    hasValidRecipient: validRecipientEmail(student.parent_email),
    attempts
  });
}));

app.post(
  '/api/students/:id/resend-gallery-email',
  requireStaff,
  ok(async (req, res) => {
    let student;
    try {
      student = await galleryStudentForEmail(db, req.params.id);
    } catch (error) {
      if (error.code === 'GALLERY_NOT_PUBLISHED') {
        return res.status(409).json({ status: 'unpublished', error: error.message });
      }
      if (error.code === 'GALLERY_EXPIRED') {
        return res.status(409).json({ status: 'expired', error: error.message });
      }
      throw error;
    }

    const recipient = String(student.parent_email || '').trim();
    if (!validRecipientEmail(recipient)) {
      return res.status(400).json({ status: 'no_recipient', error: 'No valid recipient email is on file.' });
    }

    let result;
    try {
      result = await sendGalleryEmail(student.id);
    } catch (error) {
      const attemptedAt = Date.now();
      await db.prepare('INSERT INTO email_log (student_id, to_email, status, detail, sent_at) VALUES (?,?,?,?,?)')
        .run(student.id, recipient, 'failed', String(error.message || error).slice(0, 300), attemptedAt);
      return res.status(502).json({ status: 'failed', error: String(error.message || error).slice(0, 300) });
    }

    await db.prepare('INSERT INTO email_log (student_id, to_email, status, sent_at) VALUES (?,?,?,?)')
      .run(student.id, result.student.parent_email, 'sent', Date.now());
    return res.json({ status: 'sent', acceptedByGateway: true, attemptedAt: result.attemptedAt });
  })
);

app.get('/api/email/pending', requireStaff, ok(async (req, res) => {
  const rows = await db
    .prepare(
      `${ROSTER_SQL} WHERE s.published_at IS NOT NULL AND s.parent_email IS NOT NULL
       AND (SELECT COUNT(*) FROM email_log e WHERE e.student_id = s.id AND e.status='sent') = 0
       ORDER BY s.last_name`
    )
    .all();
  res.json(rows.map(studentPublic));
}));

app.get('/api/email/export.csv', requireStaff, ok(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM students ORDER BY last_name, first_name').all();
  const cfg = config();
  const esc = (v) => {
    const value = String(v ?? '');
    const safe = /^[\u0000-\u0020]*[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = [['Student', 'Grade', 'Teacher', 'Parent email', 'Gallery link', 'Expires', 'Gallery status'].map(esc).join(',')];
  for (const s of rows) {
    const published = Boolean(s.published_at && s.gallery_token);
    lines.push(
      [
        `${s.first_name} ${s.last_name}`,
        s.grade,
        s.teacher,
        s.parent_email,
        published ? galleryLink(s) : '',
        published && s.expires_at ? new Date(s.expires_at).toLocaleDateString() : '',
        published ? 'Published' : 'Not published'
      ]
        .map(esc)
        .join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="gallery-links.csv"');
  res.send(lines.join('\n'));
}));

app.post(
  '/api/email/send',
  requireStaff,
  ok(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one student.' });
    if (!mail.configured()) return res.status(400).json({ error: 'SMTP is not configured in .env.' });

    const out = { sent: 0, failed: 0, errors: [] };
    for (const id of ids) {
      let s;
      try {
        s = await galleryStudentForEmail(db, id);
      } catch (error) {
        out.failed++;
        out.errors.push({ id, error: error.message });
        continue;
      }
      if (!s.parent_email) {
        out.failed++;
        out.errors.push({ id, error: 'missing email' });
        continue;
      }
      try {
        const result = await sendGalleryEmail(id);
        await db.prepare('INSERT INTO email_log (student_id, to_email, status, sent_at) VALUES (?,?,?,?)').run(
          result.student.id, result.student.parent_email, 'sent', Date.now()
        );
        out.sent++;
      } catch (e) {
        await db.prepare('INSERT INTO email_log (student_id, to_email, status, detail, sent_at) VALUES (?,?,?,?,?)').run(
          s.id, s.parent_email, 'failed', String(e.message).slice(0, 300), Date.now()
        );
        out.failed++;
        out.errors.push({ id, error: e.message });
      }
    }
    res.json(out);
  })
);

app.post(
  '/api/email/test',
  requireStaff,
  ok(async (req, res) => {
    const cfg = config();
    const to = String(req.body?.to || '').trim();
    if (!to) return res.status(400).json({ error: 'Enter an address to send the test to.' });
    const b = branding('published');
    const vars = {
      student: 'Sample Student', first: 'Sample', school: b.schoolName, event: b.eventName, year: b.year,
      link: buildGalleryLink('A'.repeat(32), cfg.publicUrl),
      expires: new Date(Date.now() + cfg.galleryDays * 864e5).toLocaleDateString()
    };
    await mail.send({
      to,
      from: cfg.emailFrom,
      replyTo: cfg.emailReplyTo,
      subject: `[test] ${mail.render(cfg.emailSubject, vars)}`,
      text: mail.render(cfg.emailBody, vars),
      link: vars.link,
      palette: b.palette
    });
    res.json({ ok: true });
  })
);

/* -------------------------------------------------------------- branding */

app.get('/api/branding', (req, res) => res.json(branding('published')));
app.get('/api/branding/draft', requireUser, (req, res) => res.json(branding('draft')));

const SAFE_FONTS = [
  'Archivo', 'Fraunces', 'Space Grotesk', 'DM Serif Display', 'Outfit', 'Bitter',
  'Sora', 'Lora', 'Chivo', 'Newsreader', 'Baloo 2', 'Rubik'
];

function sanitizeBranding(input, previous) {
  const str = (v, max, fallback) => {
    const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
    return s || fallback;
  };
  const hex = (v, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : fallback);
  const font = (v, fallback) => (SAFE_FONTS.includes(v) ? v : fallback);
  const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
  const surface = (value, fallback, extra = {}) => ({
    primary: hex(value?.primary, fallback.primary),
    accent: hex(value?.accent, fallback.accent),
    ink: hex(value?.ink, fallback.ink),
    paper: hex(value?.paper, fallback.paper),
    panel: hex(value?.panel, fallback.panel),
    backdrop: pick(value?.backdrop, ['paper', 'tint', 'grid', 'halftone'], fallback.backdrop),
    ...extra(value, fallback)
  });
  const layout = (value, allowed, fallback) => {
    const next = Array.isArray(value) ? value.filter((item) => allowed.includes(item)) : [];
    return [...new Set([...next, ...fallback.filter((item) => !next.includes(item))])];
  };
  const blocks = (value, fallback) => {
    const allowedImages = new Set((fallback || []).filter((block) => block.type === 'image').map((block) => block.src));
    return (Array.isArray(value) ? value : fallback || []).slice(0, 24).map((block, index) => {
      const type = block?.type === 'image' ? 'image' : 'text';
      const number = (candidate, min, max, defaultValue) => {
        const parsed = Number(candidate);
        return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : defaultValue;
      };
      const text = typeof block?.text === 'string' ? block.text.trim().slice(0, 240) : '';
      const src = typeof block?.src === 'string' && /^[\w.-]+$/.test(block.src) && allowedImages.has(block.src) ? block.src : '';
      return {
        id: typeof block?.id === 'string' && /^[\w-]+$/.test(block.id) ? block.id : `block-${index + 1}`,
        type,
        text,
        src,
        x: number(block?.x, 0, 92, 8),
        y: number(block?.y, 0, 92, 8),
        width: number(block?.width, 8, 100, 32),
        size: number(block?.size, 0.7, 8, 1.4),
        color: pick(block?.color, ['primary', 'accent', 'ink', 'paper'], 'ink')
      };
    }).filter((block) => (block.type === 'text' && block.text) || (block.type === 'image' && block.src));
  };
  const offset = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(-40, Math.min(40, parsed)) : fallback;
  };

  return {
    schoolName: str(input.schoolName, 80, previous.schoolName),
    eventName: str(input.eventName, 60, previous.eventName),
    year: str(input.year, 12, previous.year),
    tagline: str(input.tagline, 140, ''),
    welcome: str(input.welcome, 600, previous.welcome),
    logo: previous.logo,
    artwork: previous.artwork,
    galleryArtwork: previous.galleryArtwork,
    credit: str(input.credit, 160, ''),
    palette: {
      primary: hex(input.palette?.primary, previous.palette.primary),
      accent: hex(input.palette?.accent, previous.palette.accent),
      ink: hex(input.palette?.ink, previous.palette.ink),
      paper: hex(input.palette?.paper, previous.palette.paper)
    },
    surfaces: {
      home: surface(input.surfaces?.home, previous.surfaces.home, (value, fallback) => ({
        heroTreatment: pick(value?.heroTreatment, ['solid', 'wash', 'duotone'], fallback.heroTreatment)
      })),
      gallery: surface(input.surfaces?.gallery, previous.surfaces.gallery, (value, fallback) => ({
        cardStyle: pick(value?.cardStyle, ['clean', 'outline', 'shadow'], fallback.cardStyle)
      }))
    },
    layouts: {
      home: layout(input.layouts?.home, ['intro', 'artwork', 'how', 'card', 'photos', 'footer'], previous.layouts.home),
      gallery: layout(input.layouts?.gallery, ['galleryHeader', 'galleryWelcome', 'photoGrid', 'footer'], previous.layouts.gallery)
    },
    hero: {
      x: offset(input.hero?.x, previous.hero.x),
      y: offset(input.hero?.y, previous.hero.y),
      headline: str(input.hero?.headline, 140, ''),
      tagline: str(input.hero?.tagline, 240, '')
    },
    heroArt: {
      x: offset(input.heroArt?.x, previous.heroArt.x),
      y: offset(input.heroArt?.y, previous.heroArt.y),
      caption: str(input.heroArt?.caption, 100, previous.heroArt.caption),
      kicker: str(input.heroArt?.kicker, 40, previous.heroArt.kicker),
      title: str(input.heroArt?.title, 60, previous.heroArt.title),
      subline: str(input.heroArt?.subline, 80, previous.heroArt.subline)
    },
    blocks: blocks(input.blocks, previous.blocks),
    headingFont: font(input.headingFont, previous.headingFont),
    bodyFont: font(input.bodyFont, previous.bodyFont),
    cornerStyle: pick(input.cornerStyle, ['sharp', 'soft', 'round'], previous.cornerStyle),
    backdrop: pick(input.backdrop, ['paper', 'tint', 'grid', 'halftone'], previous.backdrop)
  };
}

app.put(
  '/api/branding/draft',
  requireUser,
  ok(async (req, res) => {
    const draft = sanitizeBranding(req.body || {}, branding('draft'));
    await setSetting('branding_draft', draft);
    res.json(draft);
  })
);

app.post(
  '/api/branding/publish',
  requireStaff,
  ok(async (req, res) => {
    const draft = branding('draft');
    await setSetting('branding_published', draft);
    res.json(draft);
  })
);

app.post(
  '/api/branding/revert',
  requireUser,
  ok(async (req, res) => {
    const published = branding('published');
    await setSetting('branding_draft', published);
    res.json(published);
  })
);

const brandUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UP_BRAND),
    filename: (req, file, cb) =>
      cb(null, `${req.params.kind}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname) || '.png'}`)
  }),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Use a PNG, JPG, GIF, WEBP or SVG.'))
});

app.post(
  '/api/branding/:kind(logo|artwork|galleryArtwork)',
  requireUser,
  brandUpload.single('image'),
  ok(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image was received.' });
    const draft = branding('draft');
    draft[req.params.kind] = req.file.filename;
    await setSetting('branding_draft', draft);
    res.json(draft);
  })
);

app.post(
  '/api/branding/block-image',
  requireUser,
  brandUpload.single('image'),
  ok(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image was received.' });
    const draft = branding('draft');
    draft.blocks = [...(draft.blocks || []), {
      id: `block-${crypto.randomBytes(6).toString('hex')}`,
      type: 'image',
      src: req.file.filename,
      text: '',
      x: 8,
      y: 8,
      width: 32,
      size: 1.4,
      color: 'ink'
    }].slice(0, 24);
    await setSetting('branding_draft', draft);
    res.json(draft);
  })
);

app.delete(
  '/api/branding/:kind(logo|artwork|galleryArtwork)',
  requireUser,
  ok(async (req, res) => {
    const draft = branding('draft');
    draft[req.params.kind] = null;
    await setSetting('branding_draft', draft);
    res.json(draft);
  })
);

app.get('/brand/:file', (req, res) => {
  if (!/^[\w.-]+$/.test(req.params.file)) return res.sendStatus(400);
  res.sendFile(path.join(UP_BRAND, req.params.file), (err) => err && res.sendStatus(404));
});

app.get('/api/fonts', (req, res) => res.json(SAFE_FONTS));

/* ----------------------------------------------------------------- stats */

app.get('/api/stats', requireStaff, ok(async (req, res) => {
  const cfg = config();
  const row = (sql, ...p) => db.prepare(sql).get(...p);

  const totals = await row('SELECT COUNT(*) total, SUM(active) active FROM students');
  const photographed = (await row(
    `SELECT COUNT(*) n FROM students s WHERE s.active = 1
     AND (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0) >= ?`,
    cfg.minPhotos
  )).n;
  const thin = (await row(
    `SELECT COUNT(*) n FROM students s WHERE s.active = 1
     AND (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0)
         BETWEEN 1 AND ?`,
    Math.max(0, cfg.minPhotos - 1)
  )).n;
  const noEmail = (await row(
    `SELECT COUNT(*) n FROM students WHERE active = 1 AND (parent_email IS NULL OR parent_email = '')`
  )).n;
  const photos = await row(
    `SELECT COUNT(*) total,
      SUM(CASE WHEN is_marker = 1 THEN 1 ELSE 0 END) markers,
      SUM(CASE WHEN is_marker = 0 AND student_id IS NOT NULL THEN 1 ELSE 0 END) matched,
      SUM(CASE WHEN is_marker = 0 AND student_id IS NULL THEN 1 ELSE 0 END) unmatched
     FROM photos`
  );
  const published = (await row('SELECT COUNT(*) n FROM students WHERE published_at IS NOT NULL')).n;
  const awaiting = (await row(
    `SELECT COUNT(*) n FROM students s WHERE s.active = 1 AND s.published_at IS NULL
     AND (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0) >= ?`,
    cfg.minPhotos
  )).n;
  const emails = (await row(
    `SELECT COUNT(DISTINCT student_id) n FROM email_log WHERE status = 'sent'`
  )).n;
  const emailPending = (await row(
    `SELECT COUNT(*) n FROM students s WHERE s.published_at IS NOT NULL AND s.parent_email IS NOT NULL
     AND (SELECT COUNT(*) FROM email_log e WHERE e.student_id = s.id AND e.status = 'sent') = 0`
  )).n;

  const tiles = (await db
    .prepare(
      `SELECT s.id, s.first_name, s.last_name, s.grade, s.published_at,
        (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0) AS n
       FROM students s WHERE s.active = 1 ORDER BY s.grade, s.last_name, s.first_name`
    )
    .all())
    .map((s) => ({
      id: s.id,
      name: `${s.first_name} ${s.last_name}`,
      grade: s.grade,
      n: s.n,
      state: s.published_at ? 'published' : s.n >= cfg.minPhotos ? 'shot' : s.n > 0 ? 'thin' : 'waiting'
    }));

  res.json({
    students: { total: totals.total, active: totals.active || 0, photographed, remaining: (totals.active || 0) - photographed, thin, noEmail },
    photos: {
      total: photos.total || 0,
      markers: photos.markers || 0,
      matched: photos.matched || 0,
      unmatched: photos.unmatched || 0
    },
    galleries: { published, awaiting },
    emails: { sent: emails, pending: emailPending, configured: mail.configured() },
    tiles,
    config: cfg
  });
}));

/* ----------------------------------------------------------- error trap */

app.use((err, req, res, next) => {
  console.error(err);
  const clientMessage = err.code === 'LIMIT_FILE_SIZE'
    ? 'That file is larger than the 60 MB limit.'
    : err.status && err.status < 500
      ? err.message
      : 'The request could not be completed. Please try again.';
  if (req.path.startsWith('/api/')) return res.status(err.status || 500).json({ error: clientMessage });
  res.status(err.status || 500).send(clientMessage);
});

initialize()
  .then(async () => {
    const first = await userCount() === 0;
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n  Picture Day is running on port ${PORT}`);
      console.log(first ? '  First run — open /setup to create the administrator.\n' : '  Staff sign-in: /login\n');
    });
  })
  .catch((error) => {
    console.error(`Picture Day startup failed: ${error.message}`);
    process.exitCode = 1;
    db.close().catch((closeError) => console.error('Failed to close MySQL pool:', closeError.message));
  });
