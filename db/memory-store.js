'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

function init(userDataDir) {
  if (db) return db;
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const dbPath = path.join(userDataDir, 'kolabrya.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      encrypted_token BLOB,
      email TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL
    );
    -- ---- Medical-records workflow tables ----
    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      date_of_birth TEXT,
      external_ref TEXT,           -- arbitrary external identifier (e.g. MRN)
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS record_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_token TEXT UNIQUE NOT NULL,        -- short token embedded in subject ([Ref: <token>])
      patient_id INTEGER REFERENCES patients(id),
      kolabrya_case_uuid TEXT,               -- if linked to a Kolabrya case
      doctor_office_name TEXT,
      doctor_email TEXT NOT NULL,
      requested_documents TEXT,              -- comma-separated or freeform
      reply_to TEXT,                         -- where the doctor should send the records (defaults to sender)
      message_id TEXT,                       -- Outlook message id of the outbound email
      conversation_id TEXT,                  -- Outlook conversationId for thread matching
      status TEXT NOT NULL DEFAULT 'sent',   -- sent | replied | downloaded | uploaded | error
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_requests_ref ON record_requests(ref_token);
    CREATE INDEX IF NOT EXISTS idx_requests_conv ON record_requests(conversation_id);
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      event_type TEXT NOT NULL,    -- email_sent | reply_received | attachment_downloaded | upload_succeeded | upload_failed | error
      request_id INTEGER REFERENCES record_requests(id),
      detail TEXT                  -- JSON string with structured payload
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
  `);
  return db;
}

function _db() {
  if (!db) throw new Error('memory-store not initialised. Call init(userDataDir) first.');
  return db;
}

// ---- Memory KV ----
function setMemory(key, value) {
  const stmt = _db().prepare(`
    INSERT INTO memory (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  stmt.run(key, JSON.stringify(value), Date.now());
}

function getMemory(key) {
  const row = _db().prepare('SELECT value FROM memory WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function getAllMemory() {
  const rows = _db().prepare('SELECT key, value FROM memory').all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}

function clearMemory() {
  _db().prepare('DELETE FROM memory').run();
}

// ---- Auth (JWT) ----
function saveAuth(encryptedToken, email) {
  _db().prepare(`
    INSERT INTO auth (id, encrypted_token, email, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET encrypted_token = excluded.encrypted_token,
                                  email = excluded.email,
                                  updated_at = excluded.updated_at
  `).run(encryptedToken, email, Date.now());
}

function loadAuth() {
  return _db().prepare('SELECT encrypted_token, email FROM auth WHERE id = 1').get() || null;
}

function clearAuth() {
  _db().prepare('DELETE FROM auth WHERE id = 1').run();
}

// ---- Logs ----
function appendLog(level, message) {
  _db().prepare('INSERT INTO logs (ts, level, message) VALUES (?, ?, ?)')
       .run(Date.now(), String(level), String(message));
}

function recentLogs(limit = 200) {
  return _db().prepare('SELECT ts, level, message FROM logs ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

function clearLogs() {
  _db().prepare('DELETE FROM logs').run();
}

// ---- Patients ----
function upsertPatient({ name, dateOfBirth, externalRef }) {
  if (!name) throw new Error('Patient name is required.');
  // No natural key, so dedupe by (name, dateOfBirth) when both present.
  const existing = _db().prepare(`
    SELECT id FROM patients WHERE name = ? AND IFNULL(date_of_birth,'') = IFNULL(?, '')
  `).get(name, dateOfBirth || null);
  if (existing) return existing.id;
  const info = _db().prepare(`
    INSERT INTO patients (name, date_of_birth, external_ref, created_at)
    VALUES (?, ?, ?, ?)
  `).run(name, dateOfBirth || null, externalRef || null, Date.now());
  return info.lastInsertRowid;
}

function getPatient(id) {
  return _db().prepare('SELECT * FROM patients WHERE id = ?').get(id) || null;
}

// ---- Record requests ----
function createRecordRequest({
  refToken, patientId, kolabryaCaseUuid, doctorOfficeName, doctorEmail,
  requestedDocuments, replyTo, messageId, conversationId,
}) {
  if (!refToken) throw new Error('refToken is required.');
  if (!doctorEmail) throw new Error('doctorEmail is required.');
  const now = Date.now();
  const info = _db().prepare(`
    INSERT INTO record_requests (
      ref_token, patient_id, kolabrya_case_uuid, doctor_office_name, doctor_email,
      requested_documents, reply_to, message_id, conversation_id,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)
  `).run(
    refToken, patientId || null, kolabryaCaseUuid || null,
    doctorOfficeName || null, doctorEmail,
    requestedDocuments || null, replyTo || null,
    messageId || null, conversationId || null,
    now, now,
  );
  return info.lastInsertRowid;
}

function findRequestByRef(refToken) {
  if (!refToken) return null;
  return _db().prepare('SELECT * FROM record_requests WHERE ref_token = ?').get(refToken) || null;
}

function findRequestByConversation(conversationId) {
  if (!conversationId) return null;
  return _db().prepare(`
    SELECT * FROM record_requests WHERE conversation_id = ? ORDER BY id DESC LIMIT 1
  `).get(conversationId) || null;
}

function updateRequest(id, patch) {
  if (!id) return;
  const allowed = ['status', 'kolabrya_case_uuid', 'message_id', 'conversation_id'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(patch[k]); }
  }
  if (!sets.length) return;
  sets.push('updated_at = ?'); vals.push(Date.now());
  vals.push(id);
  _db().prepare(`UPDATE record_requests SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function listRecordRequests({ limit = 200, status } = {}) {
  if (status) {
    return _db().prepare(`
      SELECT r.*, p.name AS patient_name FROM record_requests r
      LEFT JOIN patients p ON p.id = r.patient_id
      WHERE r.status = ? ORDER BY r.id DESC LIMIT ?
    `).all(status, limit);
  }
  return _db().prepare(`
    SELECT r.*, p.name AS patient_name FROM record_requests r
    LEFT JOIN patients p ON p.id = r.patient_id
    ORDER BY r.id DESC LIMIT ?
  `).all(limit);
}

// ---- Audit ----
function recordAudit(eventType, requestId, detail) {
  const payload = detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail));
  _db().prepare(`
    INSERT INTO audit_events (ts, event_type, request_id, detail) VALUES (?, ?, ?, ?)
  `).run(Date.now(), String(eventType), requestId || null, payload);
}

function listAudit({ limit = 200, requestId } = {}) {
  if (requestId) {
    return _db().prepare(`
      SELECT * FROM audit_events WHERE request_id = ? ORDER BY id DESC LIMIT ?
    `).all(requestId, limit);
  }
  return _db().prepare(`
    SELECT * FROM audit_events ORDER BY id DESC LIMIT ?
  `).all(limit);
}

module.exports = {
  init,
  setMemory, getMemory, getAllMemory, clearMemory,
  saveAuth, loadAuth, clearAuth,
  appendLog, recentLogs, clearLogs,
  upsertPatient, getPatient,
  createRecordRequest, findRequestByRef, findRequestByConversation,
  updateRequest, listRecordRequests,
  recordAudit, listAudit,
};
