'use strict';

const path = require('path');
const os = require('os');

/**
 * List of directories users may NOT pick. Compares case-insensitively on Win32.
 * The check is "is the chosen path inside one of these?" — so picking
 * C:\Windows\Temp is also blocked.
 */
const BLOCKED_ROOTS = (() => {
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [sysRoot, programFiles, programFilesX86, 'C:\\ProgramData'];
  }
  // POSIX
  return ['/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/System', '/Library/System'];
})();

function normalize(p) {
  if (!p) return '';
  let n = path.resolve(p);
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

function isInside(child, parent) {
  const c = normalize(child);
  const p = normalize(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  const sep = process.platform === 'win32' ? '\\' : '/';
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Throws if `folderPath` is empty, the OS root, the user's home root, or
 * inside a blocked system directory.
 */
function assertSafeFolder(folderPath) {
  if (!folderPath || typeof folderPath !== 'string') {
    throw new Error('No folder path supplied.');
  }
  const resolved = path.resolve(folderPath);
  const parsed = path.parse(resolved);

  if (resolved === parsed.root) {
    throw new Error(`Refusing to operate on filesystem root: ${resolved}`);
  }
  if (normalize(resolved) === normalize(os.homedir())) {
    throw new Error('Refusing to operate on the entire home directory. Pick a subfolder.');
  }
  for (const blocked of BLOCKED_ROOTS) {
    if (isInside(resolved, blocked)) {
      throw new Error(`Refusing to operate on protected system folder: ${blocked}`);
    }
  }
  return resolved;
}

module.exports = { assertSafeFolder, isInside };
