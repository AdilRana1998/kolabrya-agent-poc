'use strict';

module.exports = {
  name: 'delete_file',
  description:
    'Delete a single file from a case. If you have only the file NAME, first call get_cases to resolve fileUuid.',
  parameters: {
    type: 'object',
    properties: {
      caseUuid: { type: 'string' },
      fileUuid: { type: 'string' },
    },
    required: ['caseUuid', 'fileUuid'],
  },
  async run(input, ctx) {
    const caseUuid = input.caseUuid || ctx.memory.get('lastCaseUuid');
    if (!caseUuid) throw new Error('No caseUuid.');
    if (!input.fileUuid) throw new Error('fileUuid is required.');
    ctx.log('info', `Deleting file ${input.fileUuid} from case ${caseUuid}…`);
    const resp = await ctx.api.post('/delete-file', { caseUuid, fileUuid: input.fileUuid });
    ctx.log('info', 'Delete acknowledged.');
    return { ok: true, raw: resp.data };
  },
};
