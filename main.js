'use strict';

require('dotenv').config();

const path = require('path');
const fsp = require('fs/promises');
const mime = require('mime-types');
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');

const memoryStore = require('./db/memory-store');
const { buildClient } = require('./api/client');
const { login: doLogin } = require('./api/auth');
const { listFiles } = require('./electron/file-system');
const { runAgent } = require('./agent/agent-engine');
const { uploadOne } = require('./api/azure-uploader');
const pLimit = require('p-limit');

// ---- App-wide singletons ----
let mainWin = null;
let loginWin = null;
let apiClient = null;
let cachedToken = null; // decrypted, in-memory only

const ENV = {
  API_BASE_URL: process.env.API_BASE_URL,
  AUTH_LOGIN_URL: process.env.AUTH_LOGIN_URL,
  DEFAULT_CASE_TYPE: process.env.DEFAULT_CASE_TYPE,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  UPLOAD_CONCURRENCY: process.env.UPLOAD_CONCURRENCY || '4',
  UPLOAD_MAX_RETRIES: process.env.UPLOAD_MAX_RETRIES || '3',
};

// ---- Helpers ----
function tokenProvider() {
  return cachedToken;
}

function ensureApiClient() {
  if (apiClient) return apiClient;
  apiClient = buildClient({ baseURL: ENV.API_BASE_URL, tokenProvider });
  return apiClient;
}

function broadcast(channel, payload) {
  // Send to whichever window is showing.
  const target = mainWin || loginWin;
  if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
}

function log(level, message) {
  const safeMsg = String(message).slice(0, 4000);
  try { memoryStore.appendLog(level, safeMsg); } catch { /* ignore */ }
  broadcast('log', { ts: Date.now(), level, message: safeMsg });
  // Also surface in dev console.

  console.log(`[${level}] ${safeMsg}`);
}

function loadStoredToken() {
  try {
    const row = memoryStore.loadAuth();
    if (!row || !row.encrypted_token) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      log('warn', 'safeStorage not available; ignoring stored token.');
      return null;
    }
    return safeStorage.decryptString(row.encrypted_token);
  } catch (err) {
    log('warn', `Failed to load stored token: ${err.message}`);
    return null;
  }
}

// ---- Memory wrapper passed to the agent ----
const memory = {
  get: (k) => memoryStore.getMemory(k),
  set: (k, v) => memoryStore.setMemory(k, v),
  all: () => memoryStore.getAllMemory(),
};

// ---- Window creation ----
function createLoginWindow() {
  loginWin = new BrowserWindow({
    width: 460,
    height: 580,
    resizable: false,
    title: 'Kolabrya — Sign in',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  loginWin.removeMenu();
  loginWin.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWin.on('closed', () => { loginWin = null; });
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'Kolabrya Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('closed', () => { mainWin = null; });
  // External links open in the browser, not in-app.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showAppropriateWindow() {
  if (cachedToken) {
    if (loginWin) loginWin.close();
    if (!mainWin) createMainWindow();
  } else {
    if (mainWin) mainWin.close();
    if (!loginWin) createLoginWindow();
  }
}

// ---- IPC handlers ----
function registerIpc() {
  // --- Auth ---
  ipcMain.handle('auth:login', async (_e, { email, password }) => {
    if (!ENV.AUTH_LOGIN_URL) throw new Error('AUTH_LOGIN_URL is not configured.');
    const { token } = await doLogin({ loginUrl: ENV.AUTH_LOGIN_URL, email, password });
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS keychain unavailable; cannot securely store JWT.');
    }
    const enc = safeStorage.encryptString(token);
    memoryStore.saveAuth(enc, email);
    cachedToken = token;
    log('info', `Logged in as ${email}.`);
    showAppropriateWindow();
    return { ok: true, email };
  });

  ipcMain.handle('auth:logout', async () => {
    cachedToken = null;
    memoryStore.clearAuth();
    log('info', 'Logged out.');
    showAppropriateWindow();
    return { ok: true };
  });

  ipcMain.handle('auth:status', async () => {
    const row = memoryStore.loadAuth();
    return { loggedIn: !!cachedToken, email: row?.email || null };
  });

  // --- Filesystem ---
  ipcMain.handle('fs:select-folder', async () => {
    const win = mainWin || loginWin;
    const res = await dialog.showOpenDialog(win, {
      title: 'Pick a folder to work with',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const folderPath = res.filePaths[0];
    try {
      const files = await listFiles(folderPath);
      memory.set('lastFolderPath', folderPath);
      log('info', `Selected folder: ${folderPath} (${files.length} file(s))`);
      return { canceled: false, folderPath, files };
    } catch (err) {
      log('error', `Folder rejected: ${err.message}`);
      throw err;
    }
  });

  ipcMain.handle('fs:list-files', async (_e, folderPath) => {
    const files = await listFiles(folderPath);
    return { folderPath, files };
  });

  // --- Cases (used by the dropdown) ---
  ipcMain.handle('case:get-cases', async () => {
    const api = ensureApiClient();
    const resp = await api.get('/get');
    const data = resp.data.body || {};
    let cases = data.cases || data.data || (Array.isArray(data) ? data : []);
    if (!Array.isArray(cases)) cases = [];
    return cases.map((c) => ({
      caseUuid: c.caseUuid || c.uuid,
      caseName: c.caseName || c.name,
      files: (c.files || c.caseFiles || []).map((f) => ({
        fileUuid: f.fileUuid || f.uuid,
        fileName: f.fileName || f.name,
      })),
    }));
  });

  // --- Agent ---
  ipcMain.handle('agent:run', async (_e, { prompt, context }) => {
    if (!cachedToken) throw new Error('Not signed in.');
    const api = ensureApiClient();
    log('info', `Agent prompt: ${prompt}`);
    const result = await runAgent({
      prompt,
      context,
      deps: {
        memory,
        env: ENV,
        apiKey: ENV.OPENAI_API_KEY,
        model: ENV.OPENAI_MODEL,
        api,
        log,
        onStep: (s) => broadcast('agent:step', s),
        onProgress: (p) => broadcast('upload:progress', p),
      },
    });
    return result;
  });

  // --- Direct upload (manual "Start Upload" button bypasses the agent) ---
  ipcMain.handle('upload:start', async (_e, { caseUuid, filePaths }) => {
    if (!cachedToken) throw new Error('Not signed in.');
    if (!caseUuid) throw new Error('caseUuid required.');
    if (!Array.isArray(filePaths) || !filePaths.length) throw new Error('No files chosen.');

    const api = ensureApiClient();
    const folderRoot = memory.get('lastFolderPath');

    // Build descriptors.
    const descriptors = await Promise.all(filePaths.map(async (p) => {
      const stat = await fsp.stat(p);
      return {
        path: p,
        name: path.basename(p),
        size: stat.size,
        mimeType: mime.lookup(p) || 'application/octet-stream',
      };
    }));

    log('info', `Manual upload: ${descriptors.length} file(s) to ${caseUuid}.`);

    const presignedReq = {
      caseUuid,
      files: descriptors.map((d) => ({
        folderName: 'autoFolder',
        fileName: d.name,
        mimeType: d.mimeType,
        size: d.size,
        fieldName: 'caseFiles',
      })),
    };
    const presignedResp = await api.post('/presigned-urls', presignedReq);
    const presigned =
      presignedResp.data?.urls ||
      presignedResp.data?.data ||
      presignedResp.data?.files ||
      presignedResp.data ||
      [];
    const byName = new Map();
    for (const p of presigned) {
      const fname = p.fileName || p.name;
      const url = p.uploadUrl || p.url || p.presignedUrl;
      const blobPath = p.blobPath || `${caseUuid}/autoFolder/${fname}`;
      if (fname && url) byName.set(fname, { url, blobPath });
    }

    const concurrency = Math.max(1, parseInt(ENV.UPLOAD_CONCURRENCY, 10) || 4);
    const maxRetries = Math.max(1, parseInt(ENV.UPLOAD_MAX_RETRIES, 10) || 3);
    const limit = pLimit(concurrency);
    const results = [];
    await Promise.all(descriptors.map((d) => limit(async () => {
      const meta = byName.get(d.name);
      if (!meta) {
        results.push({ fileName: d.name, ok: false, error: 'no presigned url' });
        broadcast('upload:progress', { fileName: d.name, status: 'error', error: 'no presigned url' });
        return;
      }
      broadcast('upload:progress', { fileName: d.name, status: 'uploading', loaded: 0, total: d.size });
      try {
        await uploadOne({
          uploadUrl: meta.url,
          filePath: d.path,
          contentType: d.mimeType,
          maxRetries,
          onProgress: ({ loaded, total }) =>
            broadcast('upload:progress', { fileName: d.name, status: 'uploading', loaded, total }),
        });
        results.push({ fileName: d.name, ok: true, blobPath: meta.blobPath });
        broadcast('upload:progress', { fileName: d.name, status: 'done', loaded: d.size, total: d.size });
        log('info', `Uploaded ${d.name}`);
      } catch (err) {
        results.push({ fileName: d.name, ok: false, error: err.message });
        broadcast('upload:progress', { fileName: d.name, status: 'error', error: err.message });
        log('error', `Upload failed for ${d.name}: ${err.message}`);
      }
    })));

    const successes = results.filter((r) => r.ok);
    if (successes.length) {
      await api.post('/add-file', {
        requestUuid: caseUuid,
        caseFileTypes: '1',
        caseFiles: successes.map((s) => ({ blobPath: s.blobPath, fileName: s.fileName })),
      });
      memory.set('lastCaseUuid', caseUuid);
      if (folderRoot) memory.set('lastFolderPath', folderRoot);
    }
    return { results };
  });

  // --- Logs / memory ---
  ipcMain.handle('logs:recent', async () => memoryStore.recentLogs(300));
  ipcMain.handle('logs:clear', async () => { memoryStore.clearLogs(); return { ok: true }; });
  ipcMain.handle('memory:all', async () => memory.all());
}

// ---- App lifecycle ----
app.whenReady().then(() => {
  memoryStore.init(app.getPath('userData'));
  cachedToken = loadStoredToken();
  registerIpc();
  showAppropriateWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) showAppropriateWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Hard guardrail: no remote content allowed in any window.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
});
