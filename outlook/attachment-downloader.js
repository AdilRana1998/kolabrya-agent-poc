'use strict';

/**
 * Save a Microsoft Graph attachment to the local filesystem with sane folder
 * organization. Folder layout is configurable via OUTLOOK_ORGANIZE_BY:
 *
 *   by_patient  ->  <root>/<patient name>/<YYYY-MM-DD>/<file>
 *   by_case     ->  <root>/<caseUuid>/<YYYY-MM-DD>/<file>
 *   by_doctor   ->  <root>/<doctor office>/<YYYY-MM-DD>/<file>
 *   flat        ->  <root>/<file>
 *
 * Filenames are sanitized (Windows + POSIX safe) and de-duplicated by
 * appending " (n)" before the extension.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sanitize = require('sanitize-filename');

function _datePart(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _folderFor({ root, organizeBy, patientName, caseUuid, doctorOffice }) {
  const safe = (s) => sanitize(String(s || 'unknown').trim()) || 'unknown';
  switch (organizeBy) {
    case 'by_patient':
      return path.join(root, safe(patientName), _datePart());
    case 'by_case':
      return path.join(root, safe(caseUuid || 'no-case'), _datePart());
    case 'by_doctor':
      return path.join(root, safe(doctorOffice), _datePart());
    case 'flat':
    default:
      return root;
  }
}

async function _uniquePath(targetDir, fileName) {
  const safeName = sanitize(fileName) || 'attachment';
  const ext = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - ext.length) || 'attachment';
  let candidate = path.join(targetDir, safeName);
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fsp.access(candidate, fs.constants.F_OK);
      candidate = path.join(targetDir, `${stem} (${n})${ext}`);
      n++;
    } catch {
      return candidate;
    }
  }
}

/**
 * @param {Buffer} buffer       File bytes.
 * @param {string} originalName Filename suggested by the email.
 * @param {object} opts         Organize hints + target root.
 * @returns {Promise<{path:string, bytes:number}>}
 */
async function saveAttachment(buffer, originalName, opts) {
  const root = opts.root;
  if (!root) throw new Error('Download root not configured.');
  const targetDir = _folderFor({
    root,
    organizeBy: opts.organizeBy || 'by_patient',
    patientName: opts.patientName,
    caseUuid: opts.caseUuid,
    doctorOffice: opts.doctorOffice,
  });
  await fsp.mkdir(targetDir, { recursive: true });
  const finalPath = await _uniquePath(targetDir, originalName || 'attachment');
  await fsp.writeFile(finalPath, buffer);
  const stat = await fsp.stat(finalPath);
  return { path: finalPath, bytes: stat.size };
}

module.exports = { saveAttachment };
