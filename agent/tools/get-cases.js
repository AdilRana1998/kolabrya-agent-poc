'use strict';

module.exports = {
  name: 'get_cases',
  description:
    'Fetch the current user\'s cases. Use to find a caseUuid by name, or to look up a fileUuid by file name within a case.',
  parameters: {
    type: 'object',
    properties: {
      filterByName: { type: 'string', description: 'Optional case name substring filter.' },
    },
    required: [],
  },
  async run(input, ctx) {
    ctx.log('info', 'Fetching user cases…');
    const resp = await ctx.api.get('/get');
    const data = resp.data || {};
    // Normalise: cases might be data.cases, data.data, or just an array.
    let cases = data.cases || data.data || (Array.isArray(data) ? data : []);
    if (!Array.isArray(cases)) cases = [];
    if (input.filterByName) {
      const q = String(input.filterByName).toLowerCase();
      cases = cases.filter((c) => String(c.caseName || c.name || '').toLowerCase().includes(q));
    }
    // Trim payload for the LLM context — don't shove raw API blobs back in.
    const slim = cases.map((c) => ({
      caseUuid: c.caseUuid || c.uuid,
      caseName: c.caseName || c.name,
      files: (c.files || c.caseFiles || []).map((f) => ({
        fileUuid: f.fileUuid || f.uuid,
        fileName: f.fileName || f.name,
      })),
    }));
    ctx.log('info', `Got ${slim.length} case(s).`);
    return { cases: slim };
  },
};
