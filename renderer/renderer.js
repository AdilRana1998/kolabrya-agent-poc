'use strict';

const { useEffect, useMemo, useRef, useState, useCallback } = React;
const h = React.createElement;

// ---------- Helpers ----------
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false });
}

// ---------- Mic SVG ----------
const MicIcon = () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
  h('path', { d: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z' }),
  h('path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }),
  h('line', { x1: 12, y1: 19, x2: 12, y2: 23 }),
  h('line', { x1: 8,  y1: 23, x2: 16, y2: 23 }),
);

// ---------- Top bar ----------
function TopBar({ email, onLogout }) {
  return h('div', { className: 'topbar' },
    h('div', { className: 'brand' },
      h('span', { className: 'dot' }), 'Kolabrya Agent'
    ),
    h('div', { className: 'spacer' }),
    h('div', { className: 'who' }, email || ''),
    h('button', { onClick: onLogout, title: 'Sign out' }, 'Sign out'),
  );
}

// ---------- Case picker ----------
function CasePanel({ cases, caseUuid, setCaseUuid, refreshCases, busy }) {
  return h('div', { className: 'panel' },
    h('header', null, 'Case',
      h('div', { className: 'actions' },
        h('button', { onClick: refreshCases, disabled: busy }, 'Refresh'),
      ),
    ),
    h('div', { className: 'body' },
      h('div', { className: 'row' },
        h('select', {
          value: caseUuid || '',
          onChange: (e) => setCaseUuid(e.target.value || null),
          style: { flex: 1 },
        },
          h('option', { value: '' }, cases.length ? '— Select a case —' : '(no cases yet — ask the agent to create one)'),
          ...cases.map((c) =>
            h('option', { key: c.caseUuid, value: c.caseUuid }, c.caseName || c.caseUuid)
          ),
        ),
      ),
      caseUuid ? h('div', { className: 'mono faint', style: { marginTop: 8 } }, caseUuid) : null,
      h('div', { className: 'muted', style: { marginTop: 12, fontSize: 12 } },
        'Tip: type ',
        h('span', { className: 'kbd' }, '"create a case called X"'),
        ' in the input below — the agent will create it and remember it.',
      ),
    ),
  );
}

// ---------- Folder + file picker ----------
function FolderPanel({ folderPath, files, selected, setSelected, onPick, onRemove, dragOver, setDragOver, onDrop }) {
  const allChecked = files.length > 0 && selected.size === files.length;
  function toggleAll() {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(files.map((f) => f.path)));
  }
  function toggle(p) {
    const next = new Set(selected);
    if (next.has(p)) next.delete(p); else next.add(p);
    setSelected(next);
  }

  return h('div', { className: 'panel' },
    h('header', null, 'Folder & files',
      h('div', { className: 'actions' },
        h('button', { onClick: onPick }, 'Select folder'),
      ),
    ),
    h('div', { className: 'body' },
      folderPath
        ? h('div', { className: 'mono faint', style: { marginBottom: 8 } }, folderPath)
        : h('div', {
            className: 'dropzone' + (dragOver ? ' over' : ''),
            onClick: onPick,
            onDragOver: (e) => { e.preventDefault(); setDragOver(true); },
            onDragLeave: () => setDragOver(false),
            onDrop: (e) => { e.preventDefault(); setDragOver(false); onDrop(e); },
          },
            'Drop a folder here, or click to choose one.'
          ),
      files.length === 0
        ? h('div', { className: 'empty' }, 'No files in this folder yet.')
        : h('div', null,
            h('div', { className: 'row', style: { marginBottom: 8 } },
              h('label', { className: 'row', style: { gap: 6 } },
                h('input', { type: 'checkbox', checked: allChecked, onChange: toggleAll, style: { width: 'auto' } }),
                h('span', { className: 'muted' }, `${selected.size}/${files.length} selected`),
              ),
            ),
            h('div', { className: 'file-list' },
              ...files.map((f) =>
                h('div', { key: f.path, className: 'file-row' },
                  h('input', {
                    type: 'checkbox',
                    checked: selected.has(f.path),
                    onChange: () => toggle(f.path),
                    style: { width: 'auto' },
                  }),
                  h('div', { className: 'name', title: f.path }, f.name),
                  h('div', { className: 'size' }, fmtBytes(f.size)),
                  h('button', {
                    title: 'Remove from list',
                    onClick: () => onRemove(f.path),
                    style: { padding: '2px 6px', fontSize: 11 },
                  }, '×'),
                )
              )
            )
          ),
    ),
  );
}

// ---------- Upload progress ----------
function UploadPanel({ progress, canUpload, onStart, busy }) {
  const items = Object.values(progress);
  return h('div', { className: 'panel' },
    h('header', null, 'Upload',
      h('div', { className: 'actions' },
        h('button', { className: 'primary', onClick: onStart, disabled: !canUpload || busy },
          busy ? 'Uploading…' : 'Start upload')
      ),
    ),
    h('div', { className: 'body' },
      items.length === 0
        ? h('div', { className: 'empty' }, 'No uploads yet. Pick files and a case, then click Start upload.')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            ...items.map((p) => {
              const pct = p.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0;
              const cls = p.status === 'error' ? 'error' : (p.status === 'done' ? 'done' : '');
              const badge = p.status === 'done'
                ? h('span', { className: 'badge ok' }, 'done')
                : p.status === 'error'
                  ? h('span', { className: 'badge err', title: p.error }, 'failed')
                  : h('span', { className: 'badge run' }, `${pct}%`);
              return h('div', { key: p.fileName },
                h('div', { className: 'row' },
                  h('div', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.fileName),
                  badge,
                ),
                h('div', { className: 'progress-track' },
                  h('div', { className: `progress-bar ${cls}`, style: { width: pct + '%' } })
                ),
                p.error ? h('div', { className: 'mono', style: { color: '#c0392b', fontSize: 11, marginTop: 2 } }, p.error) : null,
              );
            })
          ),
    ),
  );
}

// ---------- Logs ----------
function LogsPanel({ lines, onClear }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  return h('div', { className: 'panel', style: { minHeight: 0 } },
    h('header', null, 'Logs',
      h('div', { className: 'actions' },
        h('button', { onClick: onClear }, 'Clear'),
      ),
    ),
    h('div', { className: 'body', style: { padding: 0 } },
      h('div', { className: 'logs', ref },
        lines.length === 0
          ? h('span', { className: 'faint' }, '(no log lines yet)')
          : lines.map((l, i) =>
              h('span', { key: i, className: 'line' },
                h('span', { className: 'ts' }, fmtTime(l.ts)),
                h('span', { className: `lvl ${l.level}` }, l.level.toUpperCase()),
                ' ',
                l.message,
              )
            )
      ),
    ),
  );
}

// ---------- Agent input (text + voice) ----------
function AgentBar({ onSubmit, busy }) {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const recogRef = useRef(null);

  const supportsVoice = typeof window !== 'undefined' &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  function startListening() {
    if (!supportsVoice) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new SR();
    r.lang = navigator.language || 'en-US';
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setText((prev) => (prev ? prev + ' ' : '') + transcript);
      setListening(false);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    recogRef.current = r;
    setListening(true);
    try { r.start(); } catch { setListening(false); }
  }
  function stopListening() {
    setListening(false);
    if (recogRef.current) {
      try { recogRef.current.stop(); } catch { /* noop */ }
    }
  }

  function submit(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    onSubmit(t);
    setText('');
  }

  return h('form', { className: 'agent-bar', onSubmit: submit },
    h('input', {
      type: 'text',
      placeholder: busy ? 'Agent is working…' : 'Ask Kolabrya — e.g. "create a case Q3 Audit and upload everything in this folder"',
      value: text,
      onChange: (e) => setText(e.target.value),
      disabled: busy,
    }),
    supportsVoice
      ? h('button', {
          type: 'button',
          className: 'mic' + (listening ? ' listening' : ''),
          onClick: listening ? stopListening : startListening,
          title: listening ? 'Stop listening' : 'Voice input',
        }, h(MicIcon))
      : null,
    h('button', { type: 'submit', className: 'primary', disabled: busy }, 'Run'),
  );
}

// ---------- Outlook panel ----------
function OutlookPanel({ outlook, monitor, requests, onConnect, onDisconnect, onToggleMonitor, onRefresh, busy }) {
  const statusBadge = outlook.connected
    ? h('span', { className: 'badge ok' }, 'connected')
    : h('span', { className: 'badge' }, 'not connected');
  const monitorBadge = monitor.active
    ? h('span', { className: 'badge ok' }, 'monitor on')
    : h('span', { className: 'badge' }, 'monitor off');

  return h('div', { className: 'panel' },
    h('header', null, 'Outlook',
      h('div', { className: 'actions' },
        h('button', { onClick: onRefresh, disabled: busy }, 'Refresh'),
        outlook.connected
          ? h('button', { onClick: onDisconnect, className: 'danger', disabled: busy }, 'Disconnect')
          : h('button', { onClick: onConnect, className: 'primary', disabled: busy }, 'Connect'),
      ),
    ),
    h('div', { className: 'body' },
      h('div', { className: 'row wrap', style: { gap: 8, marginBottom: 8 } },
        statusBadge,
        outlook.username ? h('span', { className: 'muted' }, outlook.username) : null,
        outlook.connected ? monitorBadge : null,
        outlook.connected
          ? h('button', { onClick: onToggleMonitor, disabled: busy, style: { padding: '2px 8px', fontSize: 11 } },
              monitor.active ? 'Pause' : 'Start')
          : null,
      ),
      !outlook.connected
        ? h('div', { className: 'muted', style: { fontSize: 12 } },
            'Connect Outlook to send records requests and auto-download replies. ',
            'Setup steps in ', h('span', { className: 'kbd' }, 'README.outlook.md'), '.'
          )
        : h('div', null,
            h('div', { className: 'muted', style: { marginBottom: 6, fontSize: 12 } },
              `${requests.length} request(s)`),
            requests.length === 0
              ? h('div', { className: 'empty' },
                  'No records requests yet. Ask the agent: ',
                  h('span', { className: 'kbd' }, '"send a records request to ..."'))
              : h('div', { className: 'file-list' },
                  ...requests.slice(0, 8).map((r) =>
                    h('div', {
                      key: r.id,
                      className: 'file-row',
                      style: { gridTemplateColumns: '1fr auto auto' },
                    },
                      h('div', { className: 'name' },
                        h('div', null, r.patient_name || '(no patient)'),
                        h('div', { className: 'mono faint', style: { fontSize: 11 } },
                          `${r.doctor_office_name || r.doctor_email} · ${r.ref_token}`),
                      ),
                      h('span', {
                        className: 'badge ' + (
                          r.status === 'uploaded' || r.status === 'downloaded' ? 'ok'
                          : r.status === 'error' ? 'err'
                          : 'run'
                        ),
                      }, r.status),
                      h('span', { className: 'faint', style: { fontSize: 11 } },
                        new Date(r.updated_at || r.created_at).toLocaleDateString()),
                    )
                  )
                )
          ),
    ),
  );
}

// ---------- App root ----------
function App() {
  const [email, setEmail] = useState(null);

  const [cases, setCases] = useState([]);
  const [caseUuid, setCaseUuid] = useState(null);
  const [casesBusy, setCasesBusy] = useState(false);

  const [folderPath, setFolderPath] = useState(null);
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [dragOver, setDragOver] = useState(false);

  const [progress, setProgress] = useState({}); // fileName -> {status, loaded, total, error}
  const [uploadBusy, setUploadBusy] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);

  const [logs, setLogs] = useState([]);

  // Outlook state
  const [outlookStatus, setOutlookStatus] = useState({ connected: false, username: null });
  const [monitorState, setMonitorState] = useState({ active: false });
  const [outlookBusy, setOutlookBusy] = useState(false);
  const [recordRequests, setRecordRequests] = useState([]);

  // --- Boot ---
  useEffect(() => {
    window.kolabrya.authStatus().then((s) => {
      if (s && s.email) setEmail(s.email);
    });
    window.kolabrya.recentLogs().then((arr) => setLogs(arr || []));
    refreshCases();
    refreshMemory();
    const offLog = window.kolabrya.onLog((line) => {
      setLogs((prev) => [...prev.slice(-499), line]);
    });
    const offProg = window.kolabrya.onProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.fileName]: { ...(prev[p.fileName] || {}), ...p } }));
    });
    const offStep = window.kolabrya.onAgentStep((s) => {
      // Surface as an info log in the UI; the main process also writes to its log table.
      const desc = s.final
        ? `agent: ${s.final}`
        : s.error
          ? `agent step ${s.i} error: ${s.error}`
          : `agent step ${s.i}: ${s.tool}`;
      setLogs((prev) => [...prev.slice(-499), { ts: Date.now(), level: 'info', message: desc }]);
    });
    const offOutlook = window.kolabrya.onOutlookEvent(() => {
      // When the monitor processes new mail, refresh the requests list.
      refreshOutlook();
    });
    refreshOutlook();
    return () => { offLog(); offProg(); offStep(); offOutlook(); };
  }, []);

  // --- Outlook actions ---
  async function refreshOutlook() {
    try {
      const [stat, mon, reqs] = await Promise.all([
        window.kolabrya.outlook.status(),
        window.kolabrya.outlook.monitorStatus(),
        window.kolabrya.records.listRequests({ limit: 50 }),
      ]);
      setOutlookStatus(stat || { connected: false });
      setMonitorState(mon || { active: false });
      setRecordRequests(reqs || []);
    } catch (e) {
      // First-load races are fine.
    }
  }
  async function connectOutlook() {
    setOutlookBusy(true);
    try {
      await window.kolabrya.outlook.connect();
      await refreshOutlook();
    } catch (e) {
      setLogs((prev) => [...prev, { ts: Date.now(), level: 'error', message: `Outlook: ${e.message}` }]);
    } finally {
      setOutlookBusy(false);
    }
  }
  async function disconnectOutlook() {
    setOutlookBusy(true);
    try {
      await window.kolabrya.outlook.disconnect();
      await refreshOutlook();
    } finally {
      setOutlookBusy(false);
    }
  }
  async function toggleMonitor() {
    setOutlookBusy(true);
    try {
      if (monitorState.active) await window.kolabrya.outlook.monitorStop();
      else await window.kolabrya.outlook.monitorStart();
      await refreshOutlook();
    } finally {
      setOutlookBusy(false);
    }
  }

  // Re-pull case list and memory after the agent runs (it may have created a case).
  async function refreshMemory() {
    try {
      const m = await window.kolabrya.getMemory();
      if (m && m.lastCaseUuid && !caseUuid) setCaseUuid(m.lastCaseUuid);
      if (m && m.lastFolderPath && !folderPath) {
        setFolderPath(m.lastFolderPath);
        try {
          const r = await window.kolabrya.listFiles(m.lastFolderPath);
          setFiles(r.files || []);
        } catch { /* ignore stale path */ }
      }
    } catch { /* ignore */ }
  }

  async function refreshCases() {
    setCasesBusy(true);
    try {
      const arr = await window.kolabrya.getCases();
      setCases(arr || []);
    } catch (e) {
      setLogs((prev) => [...prev, { ts: Date.now(), level: 'error', message: `getCases: ${e.message}` }]);
    } finally {
      setCasesBusy(false);
    }
  }

  async function pickFolder() {
    try {
      const r = await window.kolabrya.selectFolder();
      if (r.canceled) return;
      setFolderPath(r.folderPath);
      setFiles(r.files || []);
      setSelected(new Set((r.files || []).map((f) => f.path)));
      setProgress({});
    } catch (e) {
      setLogs((prev) => [...prev, { ts: Date.now(), level: 'error', message: e.message }]);
    }
  }

  function handleDrop(e) {
    // Electron exposes file paths on dragged items.
    const items = Array.from(e.dataTransfer.files || []);
    if (!items.length) return;
    // If user dropped a directory, Chromium will give us a single entry with no .path on web; in Electron .path is set.
    const first = items[0];
    if (first && first.path) {
      // If it looks like a directory (no extension and small size), try to list it.
      window.kolabrya.listFiles(first.path).then((r) => {
        setFolderPath(r.folderPath);
        setFiles(r.files || []);
        setSelected(new Set((r.files || []).map((f) => f.path)));
      }).catch((err) => {
        setLogs((prev) => [...prev, { ts: Date.now(), level: 'error', message: err.message }]);
      });
    }
  }

  function removeFromList(p) {
    setFiles((prev) => prev.filter((f) => f.path !== p));
    setSelected((prev) => {
      const n = new Set(prev);
      n.delete(p);
      return n;
    });
  }

  async function startUpload() {
    if (!caseUuid) {
      setLogs((prev) => [...prev, { ts: Date.now(), level: 'warn', message: 'Pick a case (or have the agent create one) before uploading.' }]);
      return;
    }
    const paths = files.filter((f) => selected.has(f.path)).map((f) => f.path);
    if (!paths.length) return;
    setUploadBusy(true);
    setProgress({});
    try {
      await window.kolabrya.uploadFiles(caseUuid, paths);
      await refreshCases();
    } catch (e) {
      setLogs((prev) => [...prev, { ts: Date.now(), level: 'error', message: e.message }]);
    } finally {
      setUploadBusy(false);
    }
  }

  async function runAgent(prompt) {
    setAgentBusy(true);
    try {
      const res = await window.kolabrya.runAgent(prompt, {
        selectedCaseUuid: caseUuid,
        selectedFolderPath: folderPath,
        selectedFileNames: files.filter((f) => selected.has(f.path)).map((f) => f.name),
      });
      if (res && res.final) {
        setLogs((prev) => [...prev, { ts: Date.now(), level: 'info', message: `agent: ${res.final}` }]);
      }
      await refreshCases();
      await refreshMemory();
      await refreshOutlook();
    } catch (e) {
      setLogs((prev) => [...prev, { ts: Date.now(), level: 'error', message: e.message }]);
    } finally {
      setAgentBusy(false);
    }
  }

  async function logout() {
    await window.kolabrya.logout();
    // main.js will swap windows; nothing else to do.
  }

  async function clearLogs() {
    await window.kolabrya.clearLogs();
    setLogs([]);
  }

  const canUpload = !!caseUuid && selected.size > 0 && !uploadBusy;

  return h('div', { className: 'app' },
    h(TopBar, { email, onLogout: logout }),
    h('div', { className: 'workspace' },
      h('div', { className: 'left-col' },
        h(CasePanel, { cases, caseUuid, setCaseUuid, refreshCases, busy: casesBusy }),
        h(FolderPanel, {
          folderPath, files, selected, setSelected,
          onPick: pickFolder, onRemove: removeFromList,
          dragOver, setDragOver, onDrop: handleDrop,
        }),
      ),
      h('div', { className: 'right-col' },
        h(UploadPanel, { progress, canUpload, onStart: startUpload, busy: uploadBusy }),
        h(OutlookPanel, {
          outlook: outlookStatus, monitor: monitorState, requests: recordRequests,
          onConnect: connectOutlook, onDisconnect: disconnectOutlook,
          onToggleMonitor: toggleMonitor, onRefresh: refreshOutlook,
          busy: outlookBusy,
        }),
        h(LogsPanel, { lines: logs, onClear: clearLogs }),
      ),
      h(AgentBar, { onSubmit: runAgent, busy: agentBusy }),
    ),
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(h(App));
