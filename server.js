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

const { db, config, branding, setSetting, newQrCode, newGalleryToken, DEFAULT_BRANDING } = require('./lib/db');
const cards = require('./lib/cards');
const mail = require('./lib/mail');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const VIEWS = path.join(ROOT, 'views');
const UP_FULL = path.join(ROOT, 'uploads', 'full');
const UP_THUMB = path.join(ROOT, 'uploads', 'thumb');
const UP_BRAND = path.join(ROOT, 'uploads', 'brand');
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
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

if (!process.env.SESSION_SECRET) {
  console.warn('\n  ⚠  SESSION_SECRET is not set in .env — using a temporary one.');
  console.warn('     Everyone will be logged out whenever the server restarts.\n');
}

app.use(
  session({
    name: 'pd.sid',
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
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
  return db.prepare('SELECT COUNT(*) n FROM users').get().n;
}
const isStaff = (req) => req.session?.user?.role === 'staff';
const isSignedIn = (req) => Boolean(req.session?.user);

function requireStaff(req, res, next) {
  if (isStaff(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in as staff to do that.' });
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

app.get('/', (req, res, next) => (userCount() === 0 ? res.redirect('/setup') : next()), page('index.html'));
app.get('/setup', (req, res) => (userCount() > 0 ? res.redirect('/login') : res.sendFile(path.join(VIEWS, 'setup.html'))));
app.get('/login', (req, res) => (userCount() === 0 ? res.redirect('/setup') : res.sendFile(path.join(VIEWS, 'login.html'))));
app.get('/admin', requireStaff, page('admin.html'));
app.get('/design', requireUser, page('design.html'));
app.get('/g/:token', page('gallery.html'));

app.use('/assets', express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));

/* ----------------------------------------------------------------- auth */

app.post(
  '/api/setup',
  loginLimiter,
  ok((req, res) => {
    if (userCount() > 0) return res.status(403).json({ error: 'Setup has already been completed.' });
    const { username, password, designPassword, schoolName } = req.body || {};
    if (!username || !password || password.length < 10)
      return res.status(400).json({ error: 'Staff password must be at least 10 characters.' });
    const now = Date.now();
    const ins = db.prepare('INSERT INTO users (username, password, role, created_at) VALUES (?,?,?,?)');
    ins.run(String(username).trim().toLowerCase(), bcrypt.hashSync(password, 12), 'staff', now);
    if (designPassword && designPassword.length >= 6)
      ins.run('design', bcrypt.hashSync(designPassword, 12), 'designer', now);
    if (schoolName) {
      const b = { ...DEFAULT_BRANDING, schoolName };
      setSetting('branding_draft', b);
      setSetting('branding_published', b);
    }
    res.json({ ok: true });
  })
);

app.post(
  '/api/login',
  loginLimiter,
  ok((req, res) => {
    const { username, password } = req.body || {};
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());
    if (!row || !bcrypt.compareSync(String(password || ''), row.password))
      return res.status(401).json({ error: 'That username and password do not match.' });
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Could not start a session.' });
      req.session.user = { id: row.id, username: row.username, role: row.role };
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
  ok((req, res) => {
    const { current, next: nextPw } = req.body || {};
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!row || !bcrypt.compareSync(String(current || ''), row.password))
      return res.status(401).json({ error: 'Current password is not right.' });
    if (!nextPw || nextPw.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters.' });
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(nextPw, 12), row.id);
    res.json({ ok: true });
  })
);

/* -------------------------------------------------------------- settings */

app.get('/api/config', requireStaff, (req, res) => res.json(config()));

app.put(
  '/api/config',
  requireStaff,
  ok((req, res) => {
    const merged = { ...config(), ...(req.body || {}) };
    merged.galleryDays = Math.max(1, Math.min(365, Number(merged.galleryDays) || 45));
    merged.minPhotos = Math.max(1, Math.min(20, Number(merged.minPhotos) || 2));
    setSetting('config', merged);
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

app.get('/api/students', requireStaff, (req, res) => {
  const rows = db.prepare(`${ROSTER_SQL} ORDER BY s.last_name, s.first_name`).all();
  res.json(rows.map(studentPublic));
});

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
  ok((req, res) => {
    const s = cleanStudent(req.body || {});
    if (!s.first_name || !s.last_name) return res.status(400).json({ error: 'First and last name are required.' });
    const info = db
      .prepare(
        `INSERT INTO students (ext_id, first_name, last_name, grade, teacher, parent_email, parent_name, notes, qr_code, created_at)
         VALUES (@ext_id, @first_name, @last_name, @grade, @teacher, @parent_email, @parent_name, @notes, @qr, @now)`
      )
      .run({ ...s, qr: newQrCode(), now: Date.now() });
    res.json(studentPublic(db.prepare(`${ROSTER_SQL} WHERE s.id = ?`).get(info.lastInsertRowid)));
  })
);

app.put(
  '/api/students/:id',
  requireStaff,
  ok((req, res) => {
    const s = cleanStudent(req.body || {});
    const exists = db.prepare('SELECT 1 FROM students WHERE id = ?').get(req.params.id);
    if (!exists) return res.status(404).json({ error: 'No such student.' });
    db.prepare(
      `UPDATE students SET ext_id=@ext_id, first_name=@first_name, last_name=@last_name, grade=@grade,
       teacher=@teacher, parent_email=@parent_email, parent_name=@parent_name, notes=@notes,
       active=@active WHERE id=@id`
    ).run({ ...s, active: req.body.active === false ? 0 : 1, id: req.params.id });
    res.json(studentPublic(db.prepare(`${ROSTER_SQL} WHERE s.id = ?`).get(req.params.id)));
  })
);

app.delete(
  '/api/students/:id',
  requireStaff,
  ok((req, res) => {
    db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

// Fresh QR code for a student whose card was lost or damaged.
app.post(
  '/api/students/:id/recode',
  requireStaff,
  ok((req, res) => {
    db.prepare('UPDATE students SET qr_code = ? WHERE id = ?').run(newQrCode(), req.params.id);
    res.json(studentPublic(db.prepare(`${ROSTER_SQL} WHERE s.id = ?`).get(req.params.id)));
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
  ok((req, res) => {
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

    const insert = db.prepare(
      `INSERT INTO students (ext_id, first_name, last_name, grade, teacher, parent_email, parent_name, notes, qr_code, created_at)
       VALUES (@extId, @firstName, @lastName, @grade, @teacher, @parentEmail, @parentName, @notes, @qr, @now)`
    );
    const updateByExt = db.prepare(
      `UPDATE students SET first_name=@firstName, last_name=@lastName, grade=@grade, teacher=@teacher,
       parent_email=@parentEmail, parent_name=@parentName, notes=@notes, active=1 WHERE id=@id`
    );

    const run = db.transaction(() => {
      if (mode === 'replace') db.prepare('UPDATE students SET active = 0').run();

      rows.forEach((raw, i) => {
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
          return;
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
          ? db.prepare('SELECT id FROM students WHERE ext_id = ?').get(payload.extId)
          : db
              .prepare('SELECT id FROM students WHERE lower(first_name)=lower(?) AND lower(last_name)=lower(?)')
              .get(payload.firstName, payload.lastName);

        if (existing) {
          updateByExt.run({ ...payload, id: existing.id });
          result.updated++;
        } else {
          insert.run({ ...payload, qr: newQrCode(), now: Date.now() });
          result.added++;
        }
      });
    });

    run();
    res.json(result);
  })
);

/* -------------------------------------------------------------- QR codes */

app.get(
  '/api/students/:id/qr.png',
  requireStaff,
  ok(async (req, res) => {
    const s = db.prepare('SELECT qr_code FROM students WHERE id = ?').get(req.params.id);
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
    const students = db.prepare(sql).all(...params);
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
  ok((req, res) => {
    const name = String(req.body?.name || '').trim() || new Date().toLocaleString();
    const info = db.prepare('INSERT INTO batches (name, created_at) VALUES (?, ?)').run(name, Date.now());
    res.json({ id: info.lastInsertRowid, name });
  })
);

app.get('/api/batches', requireStaff, (req, res) =>
  res.json(
    db
      .prepare(
        `SELECT b.*, (SELECT COUNT(*) FROM photos p WHERE p.batch_id = b.id) AS photos
         FROM batches b ORDER BY b.created_at DESC`
      )
      .all()
  )
);

app.post(
  '/api/upload',
  requireStaff,
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]),
  ok((req, res) => {
    const f = req.files?.file?.[0];
    if (!f) return res.status(400).json({ error: 'No photo was received.' });
    const thumb = req.files?.thumb?.[0];
    const info = db
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

function sortBatch(batchId) {
  const students = db.prepare('SELECT id, qr_code FROM students').all();
  const byCode = new Map(students.map((s) => [s.qr_code.toUpperCase(), s.id]));
  const photos = db
    .prepare('SELECT * FROM photos WHERE batch_id = ? ORDER BY COALESCE(captured_at, 0), seq_index, id')
    .all(batchId);

  const setMarker = db.prepare('UPDATE photos SET student_id=?, is_marker=1, hidden=1 WHERE id=?');
  const setPhoto = db.prepare('UPDATE photos SET student_id=?, is_marker=0 WHERE id=?');

  let current = null;
  const stats = { markers: 0, matched: 0, unmatched: 0, unknownCodes: [] };

  const run = db.transaction(() => {
    for (const p of photos) {
      const code = normalizeCode(p.qr_value);
      if (code && byCode.has(code)) {
        current = byCode.get(code);
        setMarker.run(current, p.id);
        stats.markers++;
        continue;
      }
      if (code && !byCode.has(code)) stats.unknownCodes.push(code);
      if (p.assigned_by === 'staff') continue; // hand-placed photos stay put
      setPhoto.run(current, p.id);
      if (current) stats.matched++;
      else stats.unmatched++;
    }
    db.prepare('UPDATE batches SET sorted_at = ? WHERE id = ?').run(Date.now(), batchId);
  });

  run();
  stats.unknownCodes = [...new Set(stats.unknownCodes)];
  return stats;
}

app.post(
  '/api/batches/:id/sort',
  requireStaff,
  ok((req, res) => res.json(sortBatch(Number(req.params.id))))
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

app.get('/api/students/:id/photos', requireStaff, (req, res) =>
  res.json(
    db
      .prepare('SELECT * FROM photos WHERE student_id = ? ORDER BY COALESCE(captured_at,0), seq_index, id')
      .all(req.params.id)
      .map(photoPublic)
  )
);

app.get('/api/photos/unassigned', requireStaff, (req, res) =>
  res.json(
    db
      .prepare(
        `SELECT p.* FROM photos p WHERE p.student_id IS NULL AND p.is_marker = 0
         ORDER BY COALESCE(p.captured_at,0), p.seq_index, p.id LIMIT 500`
      )
      .all()
      .map(photoPublic)
  )
);

app.get('/api/photos/:id/file', requireStaff, (req, res) => {
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!p) return res.sendStatus(404);
  const thumb = req.query.size === 'thumb' && p.thumb;
  res.sendFile(path.join(thumb ? UP_THUMB : UP_FULL, thumb ? p.thumb : p.file));
});

app.post(
  '/api/photos/:id/assign',
  requireStaff,
  ok((req, res) => {
    const studentId = req.body?.studentId ? Number(req.body.studentId) : null;
    db.prepare('UPDATE photos SET student_id = ?, assigned_by = ?, hidden = 0 WHERE id = ?').run(
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
  ok((req, res) => {
    db.prepare('UPDATE photos SET hidden = ?, published = CASE WHEN ? THEN 0 ELSE published END WHERE id = ?').run(
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
  ok((req, res) => {
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
    if (p) {
      fs.rm(path.join(UP_FULL, p.file), () => {});
      if (p.thumb) fs.rm(path.join(UP_THUMB, p.thumb), () => {});
      db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
    }
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------- galleries */

function publishStudent(id) {
  const cfg = config();
  const s = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
  if (!s) return null;
  const token = s.gallery_token || newGalleryToken();
  const expires = Date.now() + cfg.galleryDays * 24 * 60 * 60 * 1000;
  db.prepare('UPDATE students SET gallery_token=?, expires_at=?, published_at=? WHERE id=?').run(
    token,
    expires,
    Date.now(),
    id
  );
  db.prepare('UPDATE photos SET published = 1 WHERE student_id = ? AND is_marker = 0 AND hidden = 0').run(id);
  return db.prepare(`${ROSTER_SQL} WHERE s.id = ?`).get(id);
}

app.post(
  '/api/students/:id/publish',
  requireStaff,
  ok((req, res) => {
    const s = publishStudent(Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'No such student.' });
    res.json(studentPublic(s));
  })
);

app.post(
  '/api/students/:id/unpublish',
  requireStaff,
  ok((req, res) => {
    db.prepare('UPDATE students SET published_at = NULL WHERE id = ?').run(req.params.id);
    db.prepare('UPDATE photos SET published = 0 WHERE student_id = ?').run(req.params.id);
    res.json({ ok: true });
  })
);

app.post(
  '/api/publish/ready',
  requireStaff,
  ok((req, res) => {
    const cfg = config();
    const rows = db
      .prepare(
        `${ROSTER_SQL} WHERE s.active = 1 AND s.published_at IS NULL
         AND (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0) >= ?`
      )
      .all(cfg.minPhotos);
    rows.forEach((r) => publishStudent(r.id));
    res.json({ published: rows.length });
  })
);

app.get(
  '/api/gallery/:token',
  galleryLimiter,
  ok((req, res) => {
    const s = db.prepare('SELECT * FROM students WHERE gallery_token = ?').get(req.params.token);
    if (!s || !s.published_at) return res.status(404).json({ error: 'not-found' });
    if (s.expires_at && s.expires_at < Date.now()) return res.status(410).json({ error: 'expired' });
    const photos = db
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

app.get('/api/gallery/:token/photo/:id', galleryLimiter, (req, res) => {
  const s = db.prepare('SELECT * FROM students WHERE gallery_token = ?').get(req.params.token);
  if (!s || !s.published_at) return res.sendStatus(404);
  if (s.expires_at && s.expires_at < Date.now()) return res.sendStatus(410);
  const p = db
    .prepare('SELECT * FROM photos WHERE id = ? AND student_id = ? AND published = 1 AND hidden = 0')
    .get(req.params.id, s.id);
  if (!p) return res.sendStatus(404);
  const thumb = req.query.size === 'thumb' && p.thumb;
  if (req.query.download)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${s.last_name}-${s.first_name}-${p.id}${path.extname(p.file) || '.jpg'}"`
    );
  res.sendFile(path.join(thumb ? UP_THUMB : UP_FULL, thumb ? p.thumb : p.file));
});

/* ----------------------------------------------------------------- email */

function galleryLink(student) {
  const cfg = config();
  const base = (cfg.publicUrl || `http://localhost:${PORT}`).replace(/\/+$/, '');
  return `${base}/g/${student.gallery_token}`;
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

app.get('/api/email/pending', requireStaff, (req, res) => {
  const rows = db
    .prepare(
      `${ROSTER_SQL} WHERE s.published_at IS NOT NULL AND s.parent_email IS NOT NULL
       AND (SELECT COUNT(*) FROM email_log e WHERE e.student_id = s.id AND e.status='sent') = 0
       ORDER BY s.last_name`
    )
    .all();
  res.json(rows.map(studentPublic));
});

app.get('/api/email/export.csv', requireStaff, (req, res) => {
  const rows = db.prepare('SELECT * FROM students WHERE published_at IS NOT NULL ORDER BY last_name').all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Student', 'Grade', 'Teacher', 'Parent email', 'Gallery link', 'Expires'].map(esc).join(',')];
  for (const s of rows) {
    lines.push(
      [
        `${s.first_name} ${s.last_name}`,
        s.grade,
        s.teacher,
        s.parent_email,
        galleryLink(s),
        s.expires_at ? new Date(s.expires_at).toLocaleDateString() : ''
      ]
        .map(esc)
        .join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="gallery-links.csv"');
  res.send(lines.join('\n'));
});

app.post(
  '/api/email/send',
  requireStaff,
  ok(async (req, res) => {
    const cfg = config();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one student.' });
    if (!mail.configured()) return res.status(400).json({ error: 'SMTP is not configured in .env.' });

    const b = branding('published');
    const out = { sent: 0, failed: 0, errors: [] };
    for (const id of ids) {
      const s = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
      if (!s || !s.parent_email || !s.gallery_token) {
        out.failed++;
        out.errors.push({ id, error: 'missing email or unpublished gallery' });
        continue;
      }
      const vars = emailVars(s);
      try {
        await mail.send({
          to: s.parent_email,
          from: cfg.emailFrom || process.env.SMTP_FROM || process.env.SMTP_USER,
          replyTo: cfg.emailReplyTo,
          subject: mail.render(cfg.emailSubject, vars),
          text: mail.render(cfg.emailBody, vars),
          link: vars.link,
          palette: b.palette
        });
        db.prepare('INSERT INTO email_log (student_id, to_email, status, sent_at) VALUES (?,?,?,?)').run(
          s.id, s.parent_email, 'sent', Date.now()
        );
        out.sent++;
      } catch (e) {
        db.prepare('INSERT INTO email_log (student_id, to_email, status, detail, sent_at) VALUES (?,?,?,?,?)').run(
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
      link: `${(cfg.publicUrl || `http://localhost:${PORT}`).replace(/\/+$/, '')}/g/sample-link`,
      expires: new Date(Date.now() + cfg.galleryDays * 864e5).toLocaleDateString()
    };
    await mail.send({
      to,
      from: cfg.emailFrom || process.env.SMTP_FROM || process.env.SMTP_USER,
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

  return {
    schoolName: str(input.schoolName, 80, previous.schoolName),
    eventName: str(input.eventName, 60, previous.eventName),
    year: str(input.year, 12, previous.year),
    tagline: str(input.tagline, 140, ''),
    welcome: str(input.welcome, 600, previous.welcome),
    logo: previous.logo,
    artwork: previous.artwork,
    credit: str(input.credit, 160, ''),
    palette: {
      primary: hex(input.palette?.primary, previous.palette.primary),
      accent: hex(input.palette?.accent, previous.palette.accent),
      ink: hex(input.palette?.ink, previous.palette.ink),
      paper: hex(input.palette?.paper, previous.palette.paper)
    },
    headingFont: font(input.headingFont, previous.headingFont),
    bodyFont: font(input.bodyFont, previous.bodyFont),
    cornerStyle: pick(input.cornerStyle, ['sharp', 'soft', 'round'], previous.cornerStyle),
    backdrop: pick(input.backdrop, ['paper', 'tint', 'grid', 'halftone'], previous.backdrop)
  };
}

app.put(
  '/api/branding/draft',
  requireUser,
  ok((req, res) => {
    const draft = sanitizeBranding(req.body || {}, branding('draft'));
    setSetting('branding_draft', draft);
    res.json(draft);
  })
);

app.post(
  '/api/branding/publish',
  requireStaff,
  ok((req, res) => {
    const draft = branding('draft');
    setSetting('branding_published', draft);
    res.json(draft);
  })
);

app.post(
  '/api/branding/revert',
  requireUser,
  ok((req, res) => {
    const published = branding('published');
    setSetting('branding_draft', published);
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
  '/api/branding/:kind(logo|artwork)',
  requireUser,
  brandUpload.single('image'),
  ok((req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image was received.' });
    const draft = branding('draft');
    draft[req.params.kind] = req.file.filename;
    setSetting('branding_draft', draft);
    res.json(draft);
  })
);

app.delete(
  '/api/branding/:kind(logo|artwork)',
  requireUser,
  ok((req, res) => {
    const draft = branding('draft');
    draft[req.params.kind] = null;
    setSetting('branding_draft', draft);
    res.json(draft);
  })
);

app.get('/brand/:file', (req, res) => {
  if (!/^[\w.-]+$/.test(req.params.file)) return res.sendStatus(400);
  res.sendFile(path.join(UP_BRAND, req.params.file), (err) => err && res.sendStatus(404));
});

app.get('/api/fonts', (req, res) => res.json(SAFE_FONTS));

/* ----------------------------------------------------------------- stats */

app.get('/api/stats', requireStaff, (req, res) => {
  const cfg = config();
  const row = (sql, ...p) => db.prepare(sql).get(...p);

  const totals = row('SELECT COUNT(*) total, SUM(active) active FROM students');
  const photographed = row(
    `SELECT COUNT(*) n FROM students s WHERE s.active = 1
     AND (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0) >= ?`,
    cfg.minPhotos
  ).n;
  const thin = row(
    `SELECT COUNT(*) n FROM students s WHERE s.active = 1
     AND (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0)
         BETWEEN 1 AND ?`,
    Math.max(0, cfg.minPhotos - 1)
  ).n;
  const noEmail = row(
    `SELECT COUNT(*) n FROM students WHERE active = 1 AND (parent_email IS NULL OR parent_email = '')`
  ).n;
  const photos = row(
    `SELECT COUNT(*) total,
      SUM(CASE WHEN is_marker = 1 THEN 1 ELSE 0 END) markers,
      SUM(CASE WHEN is_marker = 0 AND student_id IS NOT NULL THEN 1 ELSE 0 END) matched,
      SUM(CASE WHEN is_marker = 0 AND student_id IS NULL THEN 1 ELSE 0 END) unmatched
     FROM photos`
  );
  const published = row('SELECT COUNT(*) n FROM students WHERE published_at IS NOT NULL').n;
  const awaiting = row(
    `SELECT COUNT(*) n FROM students s WHERE s.active = 1 AND s.published_at IS NULL
     AND (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0) >= ?`,
    cfg.minPhotos
  ).n;
  const emails = row(
    `SELECT COUNT(DISTINCT student_id) n FROM email_log WHERE status = 'sent'`
  ).n;
  const emailPending = row(
    `SELECT COUNT(*) n FROM students s WHERE s.published_at IS NOT NULL AND s.parent_email IS NOT NULL
     AND (SELECT COUNT(*) FROM email_log e WHERE e.student_id = s.id AND e.status = 'sent') = 0`
  ).n;

  const tiles = db
    .prepare(
      `SELECT s.id, s.first_name, s.last_name, s.grade, s.published_at,
        (SELECT COUNT(*) FROM photos p WHERE p.student_id = s.id AND p.is_marker = 0 AND p.hidden = 0) AS n
       FROM students s WHERE s.active = 1 ORDER BY s.grade, s.last_name, s.first_name`
    )
    .all()
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
});

/* ----------------------------------------------------------- error trap */

app.use((err, req, res, next) => {
  console.error(err);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the 60 MB limit.' : err.message || 'Something went wrong.';
  if (req.path.startsWith('/api/')) return res.status(400).json({ error: msg });
  res.status(500).send(msg);
});

app.listen(PORT, () => {
  const first = userCount() === 0;
  console.log(`\n  Picture Day is running at http://localhost:${PORT}`);
  console.log(first ? '  First run — open that address to create the staff account.\n' : '  Staff sign-in: /login\n');
});
