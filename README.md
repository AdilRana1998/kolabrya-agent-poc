# Kolabrya Agent

Electron desktop app with an MCP-style AI agent that orchestrates Kolabrya
case + file workflows from voice or text prompts.

## What it does

Speak or type something like:

> "Create a case called Q3 Audit and upload everything from D:\docs"

The agent will:

1. Plan a tool sequence with an LLM (OpenAI, JSON-mode).
2. Call `create_case` against the Kolabrya API.
3. Read your local folder through Electron's main process (sandboxed).
4. Get presigned Azure URLs, PUT every file in parallel (with retries), then
   register them via `add-file`.
5. Persist `lastCaseUuid` and `lastFolderPath` so "upload more files to my last
   case" works without you repeating yourself.

## Architecture

```
+-------------------+        +---------------------+        +------------------+
|  React renderer   | <--->  |  Electron main      | <--->  |  Agent engine    |
|  (login + dash)   |  IPC   |  (file IO, JWT)     |  call  |  (LLM loop)      |
+-------------------+        +---------------------+        +------------------+
                                       |                              |
                                       v                              v
                               +--------------+              +-----------------+
                               | SQLite       |              | Tool registry   |
                               | memory + JWT |              | create_case ... |
                               +--------------+              +-----------------+
                                                                     |
                                                                     v
                                                       +-----------------------------+
                                                       | Kolabrya API + Azure Blob   |
                                                       +-----------------------------+
```

- **Agent engine** (`agent/agent-engine.js`) runs a bounded ReAct-style loop
  (max 6 steps). Each step asks the LLM for `{ "tool": "...", "input": {...} }`
  in strict JSON mode, executes the tool, feeds the result back in.
- **Tool registry** (`agent/tool-registry.js`) is the MCP-style surface. Adding
  a tool = drop a file in `agent/tools/`.
- **Memory** (`agent/memory-store.js`) is a tiny key/value table in SQLite. The
  engine auto-injects `lastCaseUuid` / `lastFolderPath` into tool inputs when
  the LLM omits them.
- **Renderer** is React loaded from CDN (no build step).

## Setup

```bash
cp .env.example .env       # fill in API_BASE_URL, OPENAI_API_KEY, etc.
npm install
npm start
```

`better-sqlite3` is a native module. If `npm install` complains, run
`npm run rebuild` to rebuild it against your installed Electron version.

## Notes & deviations from the spec

- **MySQL vs SQLite.** The spec says "simple MySQL", but a desktop Electron app
  shouldn't require users to run a MySQL server. We use `better-sqlite3` (file
  on disk, zero config). Memory access is wrapped in `agent/memory-store.js`
  so swapping in `mysql2` later is a one-file change.
- **React without a bundler.** React 18 UMD + a tiny `h(...)` helper, so the
  app stays runnable with just `npm install && npm start`. Migrate to Vite if
  you want JSX + tree-shaking later.
- **JWT storage.** The token is encrypted via Electron `safeStorage` and held
  in SQLite. It is never exposed to the renderer; the renderer asks main to
  perform authenticated calls.
- **Path safety.** `electron/security.js` blocks selecting system folders
  (`C:\Windows`, `/etc`, `/System`, `/usr`, etc.) before any read.
- **Concurrency.** Uploads run through `p-limit` (default 4 in parallel), each
  with up to 3 retries and exponential backoff.

## Tool reference

| Tool                | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `create_case`       | POST `/create`                                   |
| `get_cases`         | GET  `/get-user`                                 |
| `read_local_files`  | List files in the user-selected folder           |
| `upload_files`      | presigned-urls -> Azure PUT -> add-file          |
| `delete_file`       | POST `/delete-file`                              |

## Voice input

Uses the Web Speech API (`webkitSpeechRecognition`). Available on Electron's
Chromium runtime out of the box. Click the mic button, speak, the transcript
fills the input and submits to the agent.
