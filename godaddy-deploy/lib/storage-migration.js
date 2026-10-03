'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const TABLES = [
  ['students', 'students'],
  ['photos', 'photos'],
  ['batches', 'batches'],
  ['users', 'users'],
  ['settings', 'settings'],
  ['galleryEmailHistory', 'gallery_email_attempts'],
  ['emailLog', 'email_log']
];

class StorageMigrationError extends Error {
  constructor(message, statusCode = 400, details = undefined) {
    super(message);
    this.name = 'StorageMigrationError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function isSafeFilename(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && path.basename(value) === value;
}

function databaseCounts(database) {
  return Object.fromEntries(
    TABLES.map(([label, table]) => [label, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count])
  );
}

function integrityResult(database) {
  return database.pragma('integrity_check').map((row) => row.integrity_check);
}

async function listFiles(directory, relative = '') {
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(directory, relative), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new StorageMigrationError(`Symbolic links are not supported in uploads: ${path.join(directory, child)}`);
    if (entry.isDirectory()) files.push(...await listFiles(directory, child));
    else if (entry.isFile()) files.push(child);
    else throw new StorageMigrationError(`Unsupported upload entry: ${path.join(directory, child)}`);
  }
  return files.sort();
}

async function countFiles(directory) {
  return (await listFiles(directory)).length;
}

async function fileExists(filePath) {
  try {
    const stat = await fs.promises.lstat(filePath);
    return stat.isFile();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function filesEqual(leftPath, rightPath) {
  let left;
  let right;
  try {
    [left, right] = await Promise.all([fs.promises.stat(leftPath), fs.promises.stat(rightPath)]);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  return left.isFile() && right.isFile() && left.size === right.size && await hashFile(leftPath) === await hashFile(rightPath);
}

function referencedBrandFiles(database) {
  const files = new Set();
  const rows = database.prepare("SELECT value FROM settings WHERE key IN ('branding_draft', 'branding_published')").all();
  for (const row of rows) {
    let branding;
    try {
      branding = JSON.parse(row.value);
    } catch {
      continue;
    }
    for (const key of ['logo', 'artwork', 'galleryArtwork']) {
      if (branding[key]) files.add(branding[key]);
    }
    for (const block of Array.isArray(branding.blocks) ? branding.blocks : []) {
      if (block?.type === 'image' && block.src) files.add(block.src);
    }
  }
  return [...files];
}

async function referenceStatus(database, directories) {
  const missing = { full: [], thumb: [], brand: [] };
  for (const photo of database.prepare('SELECT file, thumb FROM photos').all()) {
    if (!isSafeFilename(photo.file) || !await fileExists(path.join(directories.full, photo.file))) {
      missing.full.push(String(photo.file || '(empty)'));
    }
    if (photo.thumb && (!isSafeFilename(photo.thumb) || !await fileExists(path.join(directories.thumb, photo.thumb)))) {
      missing.thumb.push(String(photo.thumb));
    }
  }
  for (const filename of referencedBrandFiles(database)) {
    if (!isSafeFilename(filename) || !await fileExists(path.join(directories.brand, filename))) {
      missing.brand.push(String(filename));
    }
  }

  const summarize = (filenames) => ({
    ok: filenames.length === 0,
    missingCount: filenames.length,
    samples: filenames.slice(0, 50)
  });
  return {
    full: summarize(missing.full),
    thumb: summarize(missing.thumb),
    brand: summarize(missing.brand)
  };
}

function inspectOpenDatabase(database) {
  return {
    integrityCheck: integrityResult(database),
    counts: databaseCounts(database)
  };
}

function inspectDatabaseFile(dbPath) {
  let stat;
  try {
    stat = fs.statSync(dbPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        databasePath: dbPath,
        exists: false,
        sizeBytes: 0,
        walSizeBytes: 0,
        shmSizeBytes: 0,
        totalDatabaseBytes: 0,
        integrityCheck: ['missing'],
        counts: null
      };
    }
    throw err;
  }
  if (!stat.isFile()) throw new StorageMigrationError(`Database path is not a file: ${dbPath}`);

  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      databasePath: dbPath,
      exists: true,
      sizeBytes: stat.size,
      walSizeBytes: fileSize(`${dbPath}-wal`),
      shmSizeBytes: fileSize(`${dbPath}-shm`),
      totalDatabaseBytes: stat.size + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`),
      ...inspectOpenDatabase(database)
    };
  } finally {
    database.close();
  }
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}

async function inspectStorage({ dbPath, directories, activeDatabase, activeDatabasePath }) {
  const usesActiveDatabase = activeDatabase && path.resolve(dbPath) === path.resolve(activeDatabasePath);
  const databaseReport = usesActiveDatabase
    ? {
        databasePath: dbPath,
        exists: true,
        sizeBytes: fileSize(dbPath),
        walSizeBytes: fileSize(`${dbPath}-wal`),
        shmSizeBytes: fileSize(`${dbPath}-shm`),
        totalDatabaseBytes: fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`),
        ...inspectOpenDatabase(activeDatabase)
      }
    : inspectDatabaseFile(dbPath);
  const counts = {};
  for (const name of ['full', 'thumb', 'brand']) counts[name] = await countFiles(directories[name]);
  let references = null;
  if (databaseReport.exists) {
    const reportDatabase = usesActiveDatabase
      ? activeDatabase
      : new Database(dbPath, { readonly: true, fileMustExist: true });
    const shouldClose = reportDatabase !== activeDatabase;
    try {
      references = await referenceStatus(reportDatabase, directories);
    } finally {
      if (shouldClose) reportDatabase.close();
    }
  }
  return { ...databaseReport, files: counts, references };
}

async function migrationStatus({ legacyDbPath, legacyDirectories, privateRoot, activeDatabase, activeDatabasePath }) {
  const privateDbPath = path.join(privateRoot, 'data', 'pictureday.db');
  const [legacy, privateStorage] = await Promise.all([
    inspectStorage({ dbPath: legacyDbPath, directories: legacyDirectories, activeDatabase, activeDatabasePath }),
    inspectStorage({
      dbPath: privateDbPath,
      directories: {
        full: path.join(privateRoot, 'uploads', 'full'),
        thumb: path.join(privateRoot, 'uploads', 'thumb'),
        brand: path.join(privateRoot, 'uploads', 'brand')
      }
    })
  ]);
  return { legacy, private: { root: privateRoot, ...privateStorage } };
}

async function planCopy(sourceDirectory, destinationDirectory) {
  const files = await listFiles(sourceDirectory);
  for (const relative of files) {
    const source = path.join(sourceDirectory, relative);
    const destination = path.join(destinationDirectory, relative);
    let stat;
    try {
      stat = await fs.promises.lstat(destination);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (!stat.isFile() || !await filesEqual(source, destination)) {
      throw new StorageMigrationError(`Refusing to overwrite a different private upload: ${destination}`, 409);
    }
  }
  return files;
}

async function copyPlannedFiles(sourceDirectory, destinationDirectory, files) {
  let copied = 0;
  let alreadyPresent = 0;
  await fs.promises.mkdir(destinationDirectory, { recursive: true });
  for (const relative of files) {
    const source = path.join(sourceDirectory, relative);
    const destination = path.join(destinationDirectory, relative);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    if (await fileExists(destination)) {
      if (!await filesEqual(source, destination)) {
        throw new StorageMigrationError(`Private upload changed during migration: ${destination}`, 409);
      }
      alreadyPresent++;
      continue;
    }
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    if (!await filesEqual(source, destination)) {
      throw new StorageMigrationError(`Copied upload failed verification: ${destination}`, 500);
    }
    copied++;
  }
  return { sourceCount: files.length, copied, alreadyPresent };
}

async function archiveExistingDatabase(dbPath, privateRoot) {
  const archiveDirectory = path.join(privateRoot, 'migration-backups', `${Date.now()}-${crypto.randomUUID()}`);
  await fs.promises.mkdir(archiveDirectory, { recursive: true });
  const snapshotPath = path.join(archiveDirectory, 'pictureday.db');
  const existing = new Database(dbPath, { fileMustExist: true });
  try {
    await existing.backup(snapshotPath);
  } finally {
    existing.close();
  }
  const snapshot = inspectDatabaseFile(snapshotPath);
  if (snapshot.integrityCheck.length !== 1 || snapshot.integrityCheck[0] !== 'ok') {
    throw new StorageMigrationError(`Existing private database backup failed integrity_check: ${snapshotPath}`, 500);
  }

  const originals = path.join(archiveDirectory, 'original-files');
  await fs.promises.mkdir(originals);
  for (const suffix of ['', '-wal', '-shm']) {
    const existingPath = `${dbPath}${suffix}`;
    try {
      await fs.promises.rename(existingPath, path.join(originals, `pictureday.db${suffix}`));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return archiveDirectory;
}

async function migrateLegacyStorage({ sourceDatabase, sourceDbPath, sourceDirectories, privateRoot, overwriteDatabase = false }) {
  if (!sourceDatabase || !fs.existsSync(sourceDbPath)) {
    throw new StorageMigrationError(`Legacy source database is missing: ${sourceDbPath}`, 404);
  }
  if (path.resolve(sourceDbPath) === path.resolve(path.join(privateRoot, 'data', 'pictureday.db'))) {
    throw new StorageMigrationError('Legacy source and private destination resolve to the same database path.', 400);
  }

  const sourceIntegrity = integrityResult(sourceDatabase);
  if (sourceIntegrity.length !== 1 || sourceIntegrity[0] !== 'ok') {
    throw new StorageMigrationError('Legacy database failed integrity_check; migration was not started.', 409, { integrityCheck: sourceIntegrity });
  }
  const sourceCounts = databaseCounts(sourceDatabase);
  const sourceReferences = await referenceStatus(sourceDatabase, sourceDirectories);
  if (Object.values(sourceReferences).some((result) => !result.ok)) {
    throw new StorageMigrationError('Legacy database references missing upload files; migration was not started.', 409, { references: sourceReferences });
  }

  const destinationDbPath = path.join(privateRoot, 'data', 'pictureday.db');
  const sidecars = [`${destinationDbPath}-wal`, `${destinationDbPath}-shm`];
  const destinationExists = await fileExists(destinationDbPath);
  const sidecarsExist = (await Promise.all(sidecars.map(fileExists))).some(Boolean);
  if (sidecarsExist && !destinationExists) {
    throw new StorageMigrationError('Private database sidecars exist without the database; inspect them before migrating.', 409);
  }
  if (destinationExists && !overwriteDatabase) {
    throw new StorageMigrationError('Private database already exists; explicit overwrite confirmation is required.', 409, {
      privateDatabasePath: destinationDbPath,
      overwriteRequired: true
    });
  }

  await fs.promises.mkdir(privateRoot, { recursive: true });
  const stageRoot = await fs.promises.mkdtemp(path.join(privateRoot, '.picture-day-migration-'));
  const stageDbPath = path.join(stageRoot, 'data', 'pictureday.db');
  const stageDirectories = {
    full: path.join(stageRoot, 'uploads', 'full'),
    thumb: path.join(stageRoot, 'uploads', 'thumb'),
    brand: path.join(stageRoot, 'uploads', 'brand')
  };
  let overwriteBackupPath = null;

  try {
    await fs.promises.mkdir(path.dirname(stageDbPath), { recursive: true });
    await sourceDatabase.backup(stageDbPath);
    for (const name of ['full', 'thumb', 'brand']) {
      const files = await listFiles(sourceDirectories[name]);
      for (const relative of files) {
        const destination = path.join(stageDirectories[name], relative);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.copyFile(path.join(sourceDirectories[name], relative), destination, fs.constants.COPYFILE_EXCL);
      }
    }

    const stagedDatabase = new Database(stageDbPath, { readonly: true, fileMustExist: true });
    let stagedSummary;
    let stagedReferences;
    try {
      stagedSummary = inspectOpenDatabase(stagedDatabase);
      stagedReferences = await referenceStatus(stagedDatabase, stageDirectories);
    } finally {
      stagedDatabase.close();
    }
    if (stagedSummary.integrityCheck.length !== 1 || stagedSummary.integrityCheck[0] !== 'ok') {
      throw new StorageMigrationError('Backed-up database failed integrity_check.', 500, { integrityCheck: stagedSummary.integrityCheck });
    }
    if (JSON.stringify(stagedSummary.counts) !== JSON.stringify(sourceCounts)) {
      throw new StorageMigrationError('Database row counts changed during backup.', 500, { sourceCounts, stagedCounts: stagedSummary.counts });
    }
    if (Object.values(stagedReferences).some((result) => !result.ok)) {
      throw new StorageMigrationError('Staged uploads do not satisfy database file references.', 500, { references: stagedReferences });
    }

    const finalDirectories = {
      full: path.join(privateRoot, 'uploads', 'full'),
      thumb: path.join(privateRoot, 'uploads', 'thumb'),
      brand: path.join(privateRoot, 'uploads', 'brand')
    };
    const plans = {};
    for (const name of ['full', 'thumb', 'brand']) {
      plans[name] = await planCopy(stageDirectories[name], finalDirectories[name]);
    }
    const copied = {};
    for (const name of ['full', 'thumb', 'brand']) {
      copied[name] = await copyPlannedFiles(stageDirectories[name], finalDirectories[name], plans[name]);
    }

    await fs.promises.mkdir(path.dirname(destinationDbPath), { recursive: true });
    if (destinationExists) overwriteBackupPath = await archiveExistingDatabase(destinationDbPath, privateRoot);
    await fs.promises.rename(stageDbPath, destinationDbPath);

    const destinationReport = inspectDatabaseFile(destinationDbPath);
    if (destinationReport.integrityCheck.length !== 1 || destinationReport.integrityCheck[0] !== 'ok') {
      throw new StorageMigrationError('Promoted private database failed integrity_check.', 500, { integrityCheck: destinationReport.integrityCheck });
    }
    const finalDb = new Database(destinationDbPath, { readonly: true, fileMustExist: true });
    let destinationReferences;
    try {
      if (JSON.stringify(databaseCounts(finalDb)) !== JSON.stringify(sourceCounts)) {
        throw new StorageMigrationError('Promoted database row counts differ from the legacy source.', 500);
      }
      destinationReferences = await referenceStatus(finalDb, finalDirectories);
    } finally {
      finalDb.close();
    }
    if (Object.values(destinationReferences).some((result) => !result.ok)) {
      throw new StorageMigrationError('Promoted uploads do not satisfy database file references.', 500, { references: destinationReferences });
    }

    return {
      migrated: true,
      sourceDatabasePath: sourceDbPath,
      privateDatabasePath: destinationDbPath,
      privateDatabaseSizeBytes: destinationReport.sizeBytes,
      counts: sourceCounts,
      integrityCheck: destinationReport.integrityCheck,
      files: copied,
      references: destinationReferences,
      overwriteBackupPath
    };
  } finally {
    await fs.promises.rm(stageRoot, { recursive: true, force: true });
  }
}

module.exports = {
  StorageMigrationError,
  databaseCounts,
  inspectDatabaseFile,
  migrationStatus,
  migrateLegacyStorage
};