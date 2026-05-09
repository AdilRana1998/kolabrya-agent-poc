'use strict';

/**
 * Download all attachments of a single Outlook message to disk, organized
 * per OUTLOOK_ORGANIZE_BY. If the message matches one of our outbound
 * record requests, the request's metadata (patient, doctor, case) drives
 * the folder layout.
 *
 * Returns an array of { fileName, path, bytes }.
 */

const path = require('path');
const { app } = require('electron');

const graph = require('../../outlook/graph-client');
const memoryStore = require('../../db/memory-store');
const { saveAttachment } = require('../../outlook/attachment-downloader');
const { extractRefToken } = require('../../outlook/email-templates');

function _downloadRoot() {
  return process.env.OUTLOOK_DOWNLOAD_ROOT ||
    path.join(app.getPath('userData'), 'inbox-records');
}

module.exports = {
  name: 'outlook_download_attachments',
  description:
    'Download every attachment from a single Outlook message to local disk. ' +
    'Files are organized into subfolders by patient/case/doctor + date. ' +
    'Returns the list of saved files with absolute paths.',
  parameters: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'Outlook message id (from outlook_list_replies).' },
      saveToFolder: {
        type: 'string',
        description: 'Override the configured download root for this call only.',
      },
    },
    required: ['messageId'],
  },
  async run(input, ctx) {
    if (!input.messageId) throw new Error('messageId is required.');

    // Pull message + attachments in two calls (Graph keeps these separate).
    const msgResp = await graph.get(`/me/messages/${encodeURIComponent(input.messageId)}`, {
      $select: 'id,subject,from,conversationId,receivedDateTime,hasAttachments',
    });
    const msg = msgResp.data;
    if (!msg) throw new Error('Message not found.');

    if (!msg.hasAttachments) {
      return { saved: [], message: 'Message has no attachments.' };
    }

    const refToken = extractRefToken(msg.subject);
    const matched =
      (refToken && memoryStore.findRequestByRef(refToken)) ||
      memoryStore.findRequestByConversation(msg.conversationId);

    let patient = null;
    if (matched && matched.patient_id) patient = memoryStore.getPatient(matched.patient_id);

    const root = input.saveToFolder || _downloadRoot();
    const organizeBy = process.env.OUTLOOK_ORGANIZE_BY || 'by_patient';

    const attResp = await graph.get(
      `/me/messages/${encodeURIComponent(input.messageId)}/attachments`,
      { $select: 'id,name,contentType,size,@odata.type,isInline' }
    );
    const attachments = (attResp.data?.value || []).filter(
      (a) => !a.isInline && a['@odata.type'] === '#microsoft.graph.fileAttachment'
    );

    if (!attachments.length) {
      return { saved: [], message: 'No file attachments (only inline / item attachments present).' };
    }

    ctx.log('info', `Downloading ${attachments.length} attachment(s) from "${msg.subject}".`);

    const saved = [];
    for (const att of attachments) {
      // Pull the bytes via $value.
      const bytes = await graph.getBytes(
        `/me/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(att.id)}/$value`
      );
      const result = await saveAttachment(bytes, att.name, {
        root,
        organizeBy,
        patientName: patient?.name,
        caseUuid: matched?.kolabrya_case_uuid,
        doctorOffice: matched?.doctor_office_name || msg.from?.emailAddress?.name,
      });
      saved.push({ fileName: att.name, path: result.path, bytes: result.bytes });
      memoryStore.recordAudit('attachment_downloaded', matched?.id || null, {
        messageId: msg.id, fileName: att.name, path: result.path, bytes: result.bytes,
      });
    }

    if (matched) {
      memoryStore.updateRequest(matched.id, { status: 'downloaded' });
    }

    return {
      messageId: msg.id,
      subject: msg.subject,
      from: msg.from?.emailAddress?.address,
      matchedRequestId: matched?.id || null,
      saved,
    };
  },
};
