'use strict';

/**
 * List inbox messages, optionally filtered to "interesting" replies — those
 * whose subject contains a [Ref: <token>] tag we created, or whose
 * conversationId matches one of our outbound requests, or simply those with
 * attachments. Used both by the agent and by the inbox monitor.
 */

const graph = require('../../outlook/graph-client');
const memoryStore = require('../../db/memory-store');
const { extractRefToken } = require('../../outlook/email-templates');

module.exports = {
  name: 'outlook_list_replies',
  description:
    'List recent inbox emails. Can filter to records-related replies (matched by [Ref: <token>] subject tag, ' +
    'or by conversationId of one of our outbound requests, or by hasAttachments=true).',
  parameters: {
    type: 'object',
    properties: {
      sinceMinutes: { type: 'number', description: 'Only return mail received within this many minutes (default 1440 = 24h).' },
      onlyMatched: { type: 'boolean', description: 'If true, only return mail that matches a known outbound request.' },
      hasAttachmentsOnly: { type: 'boolean', description: 'If true, only return messages with attachments.' },
      max: { type: 'number', description: 'Max messages to return (default 50).' },
    },
    required: [],
  },
  async run(input, ctx) {
    const sinceMin = Number.isFinite(input.sinceMinutes) ? input.sinceMinutes : 1440;
    const since = new Date(Date.now() - sinceMin * 60_000).toISOString();
    const top = Math.min(200, Number.isFinite(input.max) ? input.max : 50);

    ctx.log('info', `Listing inbox messages since ${since} (top ${top}).`);
    const params = {
      $top: top,
      $orderby: 'receivedDateTime desc',
      $select: 'id,subject,from,receivedDateTime,conversationId,hasAttachments,bodyPreview,isRead',
      $filter: `receivedDateTime ge ${since}`,
    };
    const resp = await graph.get('/me/mailFolders/Inbox/messages', params);
    let items = resp.data?.value || [];

    const enriched = items.map((m) => {
      const refToken = extractRefToken(m.subject);
      let request = refToken ? memoryStore.findRequestByRef(refToken) : null;
      if (!request && m.conversationId) {
        request = memoryStore.findRequestByConversation(m.conversationId);
      }
      return {
        id: m.id,
        subject: m.subject,
        from: m.from?.emailAddress?.address,
        receivedAt: m.receivedDateTime,
        conversationId: m.conversationId,
        hasAttachments: !!m.hasAttachments,
        isRead: !!m.isRead,
        bodyPreview: (m.bodyPreview || '').slice(0, 240),
        matched: !!request,
        matchedRefToken: refToken || null,
        matchedRequestId: request ? request.id : null,
      };
    });

    let out = enriched;
    if (input.onlyMatched) out = out.filter((x) => x.matched);
    if (input.hasAttachmentsOnly) out = out.filter((x) => x.hasAttachments);

    return { count: out.length, messages: out };
  },
};
