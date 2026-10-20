#!/usr/bin/env node
'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveAssetRoot } = require('../lib/photo-storage');
const { restorePhotoFiles } = require('../lib/photo-restore');

function parseArguments(args) {
  const options = { manifest: null, apply: false, dryRunSpecified: false };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--manifest' && args[index + 1] && !args[index + 1].startsWith('--')) {
      options.manifest = args[++index];
    } else if (args[index] === '--dry-run') {
      options.apply = false;
      options.dryRunSpecified = true;
    } else if (args[index] === '--apply') {
      options.apply = true;
    } else if (args[index] === '--help') {
      options.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${args[index]}`);
    }
  }
  if (!options.help && !options.manifest) throw new Error('Specify --manifest <path>.');
  if (options.apply && options.dryRunSpecified) {
    throw new Error('Choose either --dry-run or --apply, not both.');
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/restore-photos.js --manifest <json-file> [--dry-run | --apply]');
    console.log('Dry-run is the default. --apply restores files only after complete validation.');
    return;
  }

  const manifestPath = path.resolve(options.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const { db } = require('../lib/db');
  const assetRoot = resolveAssetRoot(path.join(__dirname, '..'), process.env.PICTUREDAY_ASSET_DIR);
  let exitCode = 0;
  try {
    const report = await restorePhotoFiles({
      db,
      manifest,
      manifestDirectory: path.dirname(manifestPath),
      assetRoot,
      apply: options.apply
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) exitCode = 1;
  } finally {
    await db.close();
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(`Photo restoration ${process.argv.includes('--apply') ? 'failed' : 'dry-run failed'}: ${error.message}`);
  process.exitCode = 1;
});
