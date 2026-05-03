'use strict';

const { listFiles } = require('../../electron/file-system');

module.exports = {
  name: 'read_local_files',
  description:
    'List files inside a local folder the user has selected. Returns name, full path, size, mimeType. ' +
    'If folderPath is omitted, falls back to memory.lastFolderPath.',
  parameters: {
    type: 'object',
    properties: {
      folderPath: { type: 'string', description: 'Absolute path to the folder.' },
      recursive: { type: 'boolean', description: 'Walk subfolders too.', default: false },
    },
    required: [],
  },
  async run(input, ctx) {
    const folderPath = input.folderPath || ctx.memory.get('lastFolderPath');
    if (!folderPath) throw new Error('No folder path. Ask the user to pick a folder first.');
    ctx.log('info', `Listing files in ${folderPath}…`);
    const files = await listFiles(folderPath, { recursive: !!input.recursive });
    ctx.memory.set('lastFolderPath', folderPath);
    ctx.log('info', `Found ${files.length} file(s).`);
    // Don't send absolute paths back to the LLM — slim and safe.
    const slim = files.map((f) => ({ name: f.name, size: f.size, mimeType: f.mimeType }));
    // Stash the full descriptors for the next tool call.
    ctx.scratch.lastFileSet = files;
    return { folderPath, count: files.length, files: slim };
  },
};
