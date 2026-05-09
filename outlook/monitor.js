'use strict';

/**
 * Background Outlook inbox monitor.
 *
 * Approach: poll the inbox at a configurable interval (OUTLOOK_POLL_SECONDS).
 * We persist the receivedDateTime of the latest message we have seen so we
 * only fetch genuinely new mail on each tick — Graph supports server-side
 * filtering via $filter=receivedDateTime gt <iso>, which is cheap.
 *
 * Why polling and not Graph subscriptions / webhooks?
 *   Subscriptions need a public HTTPS callback URL (impractical for a
 *   laptop). Polling 60s is simple, robust, and well within Graph quotas
 *   for a single mailbox.
 *
 * On each new message:
 *   1. Try to match it to a known outbound request (by [Ref:] tag in the
 *      subject, falling back to conversationId).
 *   2. If matched, download attachments and (optionally) upload them to
 *      the linked Kolabrya case.
 *   3. Record audit events at every step.
 *
 * Errors during a tick are logged and swallowed so the monitor never dies.
 */

const path = require('path');
const { app } = require('electron');

const graph = require('./graph-client');
const memoryStore = require('../db/memory-store');
const { extractRefToken } = require('./email-templates');
const { saveAttachment } = require('./attachment-downloader');

const LAST_SEEN_KEY = 'outlook_monitor_last_seen_iso';

let timer = null;
let isRunning = false; // prevent overlapping ticks
let _logger = null;
let _broadcaster = null;
let _uploader = null; // optional async fn(caseUuid, filePaths) -> result

function _log(level, msg) {
  if (_logger) try { _logger(level, msg); } catch { /* noop */ }
}
function _emit(channel, payload) {
  if (_broadcaster) try { _broadcaster(channel, payload); } catch { /* noop */ }
}

function _downloadRoot() {
  return process.env.OUTLOOK_DOWNLOAD_ROOT ||
    path.join(app.getPath('userData'), 'inbox-records');
}

async function _processMessage(m) {
  // Match to an outbound request.
  const refToken = extractRefToken(m.subject);
  let request = refToken ? memoryStore.findRequestByRef(refToken) : null;
  if (!request && m.conversationId) {
    request = memoryStore.findRequestByConversation(m.conversationId);
  }

  memoryStore.recordAudit('reply_received', request?.id || null, {
    messageId: m.id,
    subject: m.subject,
    from: m.from?.emailAddress?.address,
    matchedRefToken: refToken,
    matchedRequestId: request?.id || null,
  });

  if (request) memoryStore.updateRequest(request.id, { status: 'replied' });

  if (!m.hasAttachments) {
    _log('info', `Reply received (no attachments): ${m.subject}`);
    _emit('outlook:event', { type: 'reply', message: m, matchedRequestId: request?.id || null });
    return;
  }

  // Download attachments.
  const patient = request?.patient_id ? memoryStore.getPatient(request.patient_id) : null;
  const root = _downloadRoot();
  const organizeBy = process.env.OUTLOOK_ORGANIZE_BY || 'by_patient';

  let attResp;
  try {
    attResp = await graph.get(
      `/me/messages/${encodeURIComponent(m.id)}/attachments`,
      { $select: 'id,name,contentType,size,@odata.type,isInline' }
    );
  } catch (err) {
    _log('error', `Could not list attachments for ${m.id}: ${err.message}`);
    return;
  }

  const attachments = (attResp.data?.value || []).filter(
    (a) => !a.isInline && a['@odata.type'] === '#microsoft.graph.fileAttachment'
  );

  const saved = [];
  for (const att of attachments) {
    try {
      const bytes = await graph.getBytes(
        `/me/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(att.id)}/$value`
      );
      const result = await saveAttachment(bytes, att.name, {
        root,
        organizeBy,
        patientName: patient?.name,
        caseUuid: request?.kolabrya_case_uuid,
        doctorOffice: request?.doctor_office_name || m.from?.emailAddress?.name,
      });
      saved.push({ fileName: att.name, path: result.path, bytes: result.bytes });
      memoryStore.recordAudit('attachment_downloaded', request?.id || null, {
        messageId: m.id, fileName: att.name, path: result.path, bytes: result.bytes,
      });
      _log('info', `Saved ${att.name} -> ${result.path}`);
    } catch (err) {
      memoryStore.recordAudit('error', request?.id || null, {
        messageId: m.id, fileName: att.name, error: err.message,
      });
      _log('error', `Failed to save ${att.name}: ${err.message}`);
    }
  }

  if (request && saved.length) {
    memoryStore.updateRequest(request.id, { status: 'downloaded' });
  }

  _emit('outlook:event', {
    type: 'attachments_saved',
    message: m,
    matchedRequestId: request?.id || null,
    saved,
  });

  // Optional: auto-upload to linked Kolabrya case.
  const auto = String(process.env.OUTLOOK_AUTO_UPLOAD_ON_MATCH || 'true').toLowerCase() === 'true';
  if (auto && request && request.kolabrya_case_uuid && saved.length && _uploader) {
    try {
      _log('info', `Auto-uploading ${saved.length} file(s) to Kolabrya case ${request.kolabrya_case_uuid}.`);
      await _uploader(request.kolabrya_case_uuid, saved.map((s) => s.path));
      memoryStore.updateRequest(request.id, { status: 'uploaded' });
      memoryStore.recordAudit('upload_succeeded', request.id, {
        caseUuid: request.kolabrya_case_uuid, fileCount: saved.length,
      });
      _emit('outlook:event', {
        type: 'auto_uploaded',
        matchedRequestId: request.id,
        caseUuid: request.kolabrya_case_uuid,
        fileCount: saved.length,
      });
    } catch (err) {
      memoryStore.recordAudit('upload_failed', request.id, { error: err.message });
      _log('error', `Auto-upload failed for request ${request.id}: ${err.message}`);
    }
  }
}

async function _tick() {
  if (isRunning) return; // skip overlapping ticks
  isRunning = true;
  try {
    const lastSeen = memoryStore.getMemory(LAST_SEEN_KEY) ||
      new Date(Date.now() - 60 * 60 * 1000).toISOString(); // first run: last hour
    const params = {
      $top: 50,
      $orderby: 'receivedDateTime asc',
      $select: 'id,subject,from,receivedDateTime,conversationId,hasAttachments',
      $filter: `receivedDateTime gt ${lastSeen}`,
    };
    const resp = await graph.get('/me/mailFolders/Inbox/messages', params);
    const items = resp.data?.value || [];
    if (items.length) {
      _log('info', `Monitor: ${items.length} new message(s) since ${lastSeen}.`);
      for (const m of items) {
        try {
          await _processMessage(m);
        } catch (err) {
          _log('error', `Monitor: error processing ${m.id}: ${err.message}`);
        }
        memoryStore.setMemory(LAST_SEEN_KEY, m.receivedDateTime);
      }
    }
  } catch (err) {
    _log('warn', `Monitor tick failed: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the polling loop.
 * @param {{ logger?: Function, broadcaster?: Function, uploader?: Function }} deps
 */
function start({ logger, broadcaster, uploader } = {}) {
  if (timer) return false;
  _logger = logger || null;
  _broadcaster = broadcaster || null;
  _uploader = uploader || null;
  const seconds = Math.max(15, parseInt(process.env.OUTLOOK_POLL_SECONDS, 10) || 60);
  _log('info', `Outlook monitor starting (interval ${seconds}s).`);
  // Run once immediately, then on interval.
  _tick();
  timer = setInterval(_tick, seconds * 1000);
  return true;
}

function stop() {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  _log('info', 'Outlook monitor stopped.');
  return true;
}

function isActive() { return !!timer; }

function resetSeen() {
  memoryStore.setMemory(LAST_SEEN_KEY, null);
}

module.exports = { start, stop, isActive, resetSeen };
