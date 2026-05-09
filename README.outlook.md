# Kolabrya Agent — Outlook integration

This module adds Microsoft Outlook automation for the medical-records request
workflow:

1. Compose + send templated requests to doctor offices.
2. Continuously monitor the inbox for replies.
3. Auto-match replies to outbound requests via `[Ref: <token>]` in the subject.
4. Download attachments to a configurable, organized local folder.
5. Optionally auto-upload received records to the linked Kolabrya case.
6. Maintain a structured audit trail.

## Architecture

```
+----------------------------+
|   Electron renderer (UI)   |
|  Outlook panel + records   |
+--------------+-------------+
               | IPC (preload)
+--------------v-------------+
|     Electron main          |
|  outlook/auth (MSAL PKCE)  |
|  outlook/monitor (60s tick)|
|  outlook/graph-client      |
+--------------+-------------+
               |
               | Microsoft Graph
               v
+----------------------------+
|  graph.microsoft.com/v1.0  |
|  /me/messages, /sendMail   |
+----------------------------+
```

Tools added to the agent registry:

| Tool                            | What it does                                          |
| ------------------------------- | ----------------------------------------------------- |
| `outlook_send_records_request`  | Render template + send via Graph + record the request |
| `outlook_list_replies`          | List inbox; flag matched replies                      |
| `outlook_download_attachments`  | Pull attachments for one message, organize on disk    |

The inbox monitor (`outlook/monitor.js`) runs on `setInterval`. On each tick it
fetches mail received since the last seen `receivedDateTime`, matches each
message to a known request (by `[Ref:]` tag, falling back to `conversationId`),
downloads attachments, and (when `OUTLOOK_AUTO_UPLOAD_ON_MATCH=true`) chains
into the existing Kolabrya `upload_files` pipeline.

## Setup — Azure AD app registration

1. Go to <https://entra.microsoft.com> → **App registrations** → **New registration**.
2. Name: `Kolabrya Agent (desktop)`. Supported account types: pick what fits
   (single tenant for org-only, multi-tenant if you'll resell).
3. Redirect URI → choose **"Mobile and desktop applications"** → add
   `http://localhost:53682/auth/callback`.
4. Click **Register**, then copy the **Application (client) ID** → put it in
   `.env` as `MSGRAPH_CLIENT_ID`.
5. **Authentication** → enable the **Allow public client flows** toggle (this
   is required for PKCE on a desktop app).
6. **API permissions** → Add a permission → Microsoft Graph → **Delegated
   permissions** → add: `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`,
   `User.Read`, `offline_access`. Click **Grant admin consent** if you're an
   admin (otherwise the user will consent on first sign-in).

That's it — no client secret needed (PKCE flow).

## .env keys

```
MSGRAPH_CLIENT_ID=<the Application (client) ID>
MSGRAPH_TENANT_ID=common              # or your tenant GUID for org-only
MSGRAPH_REDIRECT_URI=http://localhost:53682/auth/callback
MSGRAPH_SCOPES=offline_access,Mail.Read,Mail.ReadWrite,Mail.Send,User.Read

OUTLOOK_POLL_SECONDS=60
OUTLOOK_DOWNLOAD_ROOT=               # optional; defaults to <userData>/inbox-records
OUTLOOK_ORGANIZE_BY=by_patient       # by_patient | by_case | by_doctor | flat
OUTLOOK_AUTO_UPLOAD_ON_MATCH=true
```

## How a full run looks

User says, in the agent input box:

> *"Send a records request to records@drsmithclinic.com for patient Jane Doe
> DOB 1980-04-12, asking for the last 12 months of progress notes and any
> imaging reports, link it to my last case."*

The agent:

1. Calls `outlook_send_records_request`. Template renders the email with a
   generated `refToken` (e.g. `K-9f2e1c4axy`) embedded in the subject:
   `Medical Records Request — Jane Doe (DOB 1980-04-12)  [Ref: K-9f2e1c4axy]`.
2. Persists the request in `record_requests` (status `sent`) and writes an
   `email_sent` audit event.
3. Returns `{ refToken, requestId, messageId, conversationId }`.

Hours later, Dr. Smith's office replies with PDFs attached. The monitor:

1. Picks up the new message (server-side filtered by `receivedDateTime gt`).
2. Extracts `K-9f2e1c4axy` from the subject; finds the request.
3. Marks request status `replied`, writes a `reply_received` audit event.
4. Downloads attachments to `<root>/Jane Doe/2026-05-08/<filename>.pdf`.
5. If `OUTLOOK_AUTO_UPLOAD_ON_MATCH=true`, uploads them to the linked
   Kolabrya case via `presigned-urls -> Azure PUT -> add-file`.
6. Updates request status to `uploaded`, writes `upload_succeeded`.

The renderer's Outlook panel reflects every state change in near-real-time.

## Where the data lives

- **Tokens.** Refresh tokens go through MSAL's serialized cache, which we
  encrypt with Electron `safeStorage` (OS keychain) and persist into the
  `memory` table under `msgraph_token_cache_v1`. Decryption keys never leave
  the user's machine.
- **Requests + audit.** `record_requests`, `audit_events`, `patients` tables
  in `kolabrya.db` (next to the existing app data). See `db/memory-store.js`
  for the schema.
- **Downloaded files.** Default `<userData>/inbox-records/`. Override via
  `OUTLOOK_DOWNLOAD_ROOT`.
- **Polling state.** The last-seen receivedDateTime lives in the `memory`
  table under `outlook_monitor_last_seen_iso`.

## Compliance notes

This build covers engineering hygiene: tokens encrypted at rest, no PHI in
LLM prompts unless you explicitly invoke a tool whose result includes it,
audit log of every send/receive/download.

For a HIPAA-aligned deployment you additionally need:

- A signed BAA with Microsoft (Azure / M365 BAA covers Graph).
- A signed BAA with whichever LLM you use. For OpenAI's public API there is
  no BAA — use **Azure OpenAI** instead and update `agent/llm-client.js`.
- Encrypted-at-rest disk on the user's machine (BitLocker / FileVault).
- A retention policy for the `audit_events` and `logs` tables.
- Logging of who-saw-what (the audit table already supports per-request
  scoping).

## Scaling out: from desktop to always-on service

The current build is single-machine: monitoring stops when the Electron
window is closed. For 24/7 operation, lift the four files below into a small
Node.js service and front them with a queue:

- `outlook/auth.js` — store the MSAL token cache in a real DB (Postgres,
  Cosmos), keyed by tenantId+userId. Switch from PKCE to Confidential Client
  if you can't keep users in the loop for re-consent.
- `outlook/graph-client.js` — unchanged.
- `outlook/monitor.js` — replace the `setInterval` with a worker process. For
  many users, swap polling for **Microsoft Graph subscriptions**: POST to
  `/subscriptions` with your service's HTTPS callback, accept the validation
  token, then process change-notification webhooks. Uses ~100x fewer Graph
  calls at scale.
- `db/memory-store.js` — swap `better-sqlite3` for `pg` / `mysql2`. The schema
  is identical.

No changes are needed in the agent tools or the email templates.
