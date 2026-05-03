'use strict';

module.exports = {
  name: 'create_case',
  description:
    'Create a new case on the Kolabrya backend. Use when the user wants a brand new case. ' +
    'Returns the created case including caseUuid which should be remembered.',
  parameters: {
    type: 'object',
    properties: {
      caseName: { type: 'string', description: 'Human-readable case name.' },
      caseType: {
        type: 'string',
        description:
          'caseType UUID. If not provided, the default from env (DEFAULT_CASE_TYPE) is used.',
      },
    },
    required: ['caseName'],
  },
  async run(input, ctx) {
    const caseName = (input.caseName || '').trim();
    if (!caseName) throw new Error('create_case requires caseName.');
    const caseType = input.caseType || ctx.env.DEFAULT_CASE_TYPE;
    if (!caseType) throw new Error('No caseType supplied and DEFAULT_CASE_TYPE is not set.');

    ctx.log('info', `Creating case "${caseName}"…`);
    const resp = await ctx.api.post('/create', { caseName, caseType });

    console.log("resp.data.body", resp.data.body);
    

    const data = resp.data.body || {};
    // Backends vary in shape; try the common ones.
    const caseUuid = data.requestUuid;
    if (!caseUuid) {
      ctx.log('warn', 'Case created but no caseUuid found in response — check API contract.');
    } else {
      ctx.memory.set('lastCaseUuid', caseUuid);
      ctx.memory.set('lastCaseName', caseName);
      ctx.log('info', `Case created: ${caseUuid}`);
    }
    return { caseUuid, caseName, raw: data };
  },
};
