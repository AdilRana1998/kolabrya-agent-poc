'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const mime = require('mime-types');
const { assertSafeFolder, isInside } = require('./security');

const HIDDEN_PREFIXES = ['.', '~$'];

function isHidden(name) {
  return HIDDEN_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * List regular files in `folderPath` (non-recursive by default).
 * Returns [{ name, path, size, mimeType }, ...]
 */
async function listFiles(folderPath, { recursive = false } = {}) {
  const safe = assertSafeFolder(folderPath);
  const out = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`Cannot read folder "${dir}": ${err.message}`);
    }
    for (const ent of entries) {
      if (isHidden(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (recursive) await walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      out.push({
        name: ent.name,
        path: full,
        size: stat.size,
        mimeType: mime.lookup(ent.name) || 'application/octet-stream',
      });
    }
  }

  await walk(safe);
  return out;
}

/**
 * Read a file as a Buffer. Asserts the file lives inside `allowedRoot`.
 */
async function readFileBuffer(filePath, allowedRoot) {
  if (allowedRoot && !isInside(filePath, allowedRoot)) {
    throw new Error(`File "${filePath}" is outside the allowed folder.`);
  }
  return fsp.readFile(filePath);
}

/**
 * Stream a file in chunks for large uploads. Returns a Node ReadStream.
 */
function createReadStream(filePath) {
  return fs.createReadStream(filePath);
}

module.exports = { listFiles, readFileBuffer, createReadStream };
