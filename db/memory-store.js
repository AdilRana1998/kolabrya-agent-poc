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

module.exports = {
  init,
  setMemory, getMemory, getAllMemory, clearMemory,
  saveAuth, loadAuth, clearAuth,
  appendLog, recentLogs, clearLogs,
};
