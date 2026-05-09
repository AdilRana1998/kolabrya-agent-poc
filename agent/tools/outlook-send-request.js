'use strict';

/**
 * Compose + send a medical-records request email via Microsoft Graph.
 * Records the request (with its ref token) so the inbox monitor can match
 * the doctor's reply back to this thread later.
 */

const graph = require('../../outlook/graph-client');
const { render } = require('../../outlook/email-templates');
const memoryStore = require('../../db/memory-store');
const { status: outlookStatus } = require('../../outlook/auth');

module.exports = {
  name: 'outlook_send_records_request',
  description:
    'Send a medical-records request email to a doctor office via Outlook. ' +
    'Embeds a [Ref: <token>] tag in the subject so replies can be auto-matched. ' +
    'Returns { refToken, requestId, messageId } on success.',
  parameters: {
    type: 'object',
    properties: {
      doctorOfficeName: { type: 'string' },
      doctorEmail: { type: 'string', description: 'Recipient email at the doctor office.' },
      patientName: { type: 'string' },
      patientDob: { type: 'string', description: 'Patient date of birth, e.g. 1980-04-12 or "April 12, 1980".' },
      requestedDocuments: {
        type: 'string',
        description:
          'Plain-text list/description of records being requested. Multi-line OK.',
      },
      caseReference: {
        type: 'string',
        description: 'Free-text reference shown to the doctor (e.g. internal case number).',
      },
      kolabryaCaseUuid: {
        type: 'string',
        description: 'Optional Kolabrya case UUID to link the request to. Falls back to memory.lastCaseUuid.',
      },
      replyTo: {
        type: 'string',
        description: 'Where the doctor should send the records. Defaults to the signed-in mailbox.',
      },
    },
    required: ['doctorEmail', 'patientName', 'requestedDocuments'],
  },
  async run(input, ctx) {
    const stat = await outlookStatus();
    if (!stat.connected) throw new Error('Outlook is not connected. Connect it first.');

    const senderEmail = stat.username;
    const senderName = stat.name || senderEmail;

    const replyTo = input.replyTo || senderEmail;
    const kolabryaCaseUuid = input.kolabryaCaseUuid || ctx.memory.get('lastCaseUuid') || null;

    // Persist patient.
    const patientId = memoryStore.upsertPatient({
      name: input.patientName,
      dateOfBirth: input.patientDob,
    });

    // Render template + generate ref token.
    const rendered = render('medical_records_request', {
      doctorOfficeName: input.doctorOfficeName || 'Records Department',
      patientName: input.patientName,
      patientDob: input.patientDob || 'unknown',
      requestedDocuments: input.requestedDocuments,
      caseReference: input.caseReference || kolabryaCaseUuid || '(no case ref)',
      replyTo,
      senderName,
    });

    // Send via Graph: POST /me/sendMail. We use a saveToSentItems=true call,
    // then look up the sent message to capture its id + conversationId.
    ctx.log('info', `Sending records request to ${input.doctorEmail} (ref ${rendered.refToken})`);
    await graph.post('/me/sendMail', {
      message: {
        subject: rendered.subject,
        body: rendered.html
          ? { contentType: 'HTML', content: rendered.html }
          : { contentType: 'Text', content: rendered.text || '' },
        toRecipients: [{ emailAddress: { address: input.doctorEmail } }],
        replyTo: replyTo ? [{ emailAddress: { address: replyTo } }] : undefined,
      },
      saveToSentItems: true,
    });

    // Find the just-sent message by subject so we can record its IDs.
    let messageId = null;
    let conversationId = null;
    try {
      const search = await graph.get('/me/mailFolders/SentItems/messages', {
        $top: 5,
        $orderby: 'sentDateTime desc',
        $select: 'id,subject,conversationId,sentDateTime',
        $filter: `subject eq '${rendered.subject.replace(/'/g, "''")}'`,
      });
      const items = search.data?.value || [];
      if (items.length) {
        messageId = items[0].id;
        conversationId = items[0].conversationId;
      }
    } catch (err) {
      // Non-fatal: matching falls back to ref token.
      ctx.log('warn', `Could not look up sent message id: ${err.message}`);
    }

    const requestId = memoryStore.createRecordRequest({
      refToken: rendered.refToken,
      patientId,
      kolabryaCaseUuid,
      doctorOfficeName: input.doctorOfficeName,
      doctorEmail: input.doctorEmail,
      requestedDocuments: input.requestedDocuments,
      replyTo,
      messageId,
      conversationId,
    });

    memoryStore.recordAudit('email_sent', requestId, {
      to: input.doctorEmail, subject: rendered.subject, messageId, conversationId,
    });
    ctx.log('info', `Records request sent (request #${requestId}, ref ${rendered.refToken}).`);

    return {
      requestId,
      refToken: rendered.refToken,
      messageId,
      conversationId,
      to: input.doctorEmail,
      subject: rendered.subject,
    };
  },
};
