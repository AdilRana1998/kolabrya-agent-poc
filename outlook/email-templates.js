'use strict';

/**
 * Tiny string-template engine. Replaces {{fieldName}} with values from the
 * supplied data object. Missing fields throw if listed in requiredFields,
 * otherwise render as empty string.
 *
 * We deliberately avoid Handlebars / Mustache to keep dependencies small;
 * the templates only need flat field interpolation.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TEMPLATES_PATH = path.join(__dirname, 'templates.json');

let cache = null;

function _load() {
  if (cache) return cache;
  const raw = fs.readFileSync(DEFAULT_TEMPLATES_PATH, 'utf8');
  cache = JSON.parse(raw);
  return cache;
}

function reload() { cache = null; return _load(); }

function listTemplates() {
  const t = _load();
  return Object.keys(t).map((name) => ({
    name,
    requiredFields: t[name].requiredFields || [],
    subjectPreview: t[name].subject,
  }));
}

function _interpolate(str, data) {
  return String(str).replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const v = data[key];
    return v == null ? '' : String(v);
  });
}

/**
 * Build an email payload from a template + data. Returns:
 *   { subject, html, text, refToken }
 *
 * If `data.refToken` is not provided, a short token is generated. The token
 * is what we use to match inbound replies.
 */
function render(templateName, data = {}) {
  const all = _load();
  const tpl = all[templateName];
  if (!tpl) throw new Error(`Unknown template "${templateName}".`);

  const refToken = data.refToken || _newRefToken();
  const merged = { ...data, refToken };

  // Validate required fields (refToken is auto-supplied).
  for (const f of tpl.requiredFields || []) {
    if (f === 'refToken') continue;
    if (merged[f] == null || merged[f] === '') {
      throw new Error(`Template "${templateName}" requires field "${f}".`);
    }
  }

  return {
    subject: _interpolate(tpl.subject, merged),
    html: tpl.html ? _interpolate(tpl.html, merged) : null,
    text: tpl.text ? _interpolate(tpl.text, merged) : null,
    refToken,
  };
}

/** Short, URL-safe-ish ref token, ~10 chars, that we embed in subject lines. */
function _newRefToken() {
  // 8 hex chars + 2 letters; collisions are vanishingly rare for our scale.
  const hex = crypto.randomBytes(4).toString('hex');
  const letters = 'abcdefghijkmnpqrstuvwxyz';
  let suffix = '';
  for (let i = 0; i < 2; i++) {
    suffix += letters[Math.floor(Math.random() * letters.length)];
  }
  return `K-${hex}${suffix}`;
}

/** Pull `[Ref: <token>]` out of a subject line. Case-insensitive on the label. */
function extractRefToken(subject) {
  if (!subject) return null;
  const m = String(subject).match(/\[\s*ref\s*:\s*([A-Za-z0-9_-]{4,32})\s*\]/i);
  return m ? m[1] : null;
}

module.exports = { render, listTemplates, extractRefToken, reload };
