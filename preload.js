'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The renderer talks to the main process exclusively through this surface.
 * Nothing in here exposes Node, fs, or the JWT directly to the page.
 */
contextBridge.exposeInMainWorld('kolabrya', {
  // ---- Auth ----
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  authStatus: () => ipcRenderer.invoke('auth:status'),

  // ---- File system ----
  selectFolder: () => ipcRenderer.invoke('fs:select-folder'),
  listFiles: (folderPath) => ipcRenderer.invoke('fs:list-files', folderPath),

  // ---- Cases ----
  getCases: () => ipcRenderer.invoke('case:get-cases'),

  // ---- Agent ----
  runAgent: (prompt, context) => ipcRenderer.invoke('agent:run', { prompt, context }),

  // ---- Direct uploads (used by the "Start Upload" button) ----
  uploadFiles: (caseUuid, filePaths) =>
    ipcRenderer.invoke('upload:start', { caseUuid, filePaths }),

  // ---- Logs ----
  recentLogs: () => ipcRenderer.invoke('logs:recent'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),

  // ---- Memory ----
  getMemory: () => ipcRenderer.invoke('memory:all'),

  // ---- Streaming events (logs + progress) ----
  onLog: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('log', listener);
    return () => ipcRenderer.removeListener('log', listener);
  },
  onProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('upload:progress', listener);
    return () => ipcRenderer.removeListener('upload:progress', listener);
  },
  onAgentStep: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('agent:step', listener);
    return () => ipcRenderer.removeListener('agent:step', listener);
  },
});
