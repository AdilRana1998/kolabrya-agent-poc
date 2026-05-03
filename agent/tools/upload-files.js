'use strict';

const path = require('path');
const pLimit = require('p-limit');
const { listFiles } = require('../../electron/file-system');
const { uploadOne } = require('../../api/azure-uploader');

const FOLDER_NAME = 'autoFolder';

/**
 * Three-step upload flow:
 *   1) POST /presigned-urls  ->  one upload URL per file
 *   2) PUT  Azure Blob       ->  parallel, with retries
 *   3) POST /add-file        ->  register the blobs against the case
 */
module.exports = {
  name: 'upload_files',
  description:
    'Upload local files to a case. Steps: presigned-urls -> Azure PUT -> add-file. ' +
    'caseUuid falls back to memory.lastCaseUuid; folderPath falls back to memory.lastFolderPath.',
  parameters: {
    type: 'object',
    properties: {
      caseUuid: { type: 'string' },
      folderPath: { type: 'string', description: 'Folder containing the files. Optional if fileNames is given.' },
      fileNames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional explicit file name list. If omitted, uploads every file in folderPath.',
      },
    },
    required: [],
  },
  async run(input, ctx) {
    const caseUuid = input.caseUuid || ctx.memory.get('lastCaseUuid');
    if (!caseUuid) throw new Error('No caseUuid. Create or pick a case first.');

    const folderPath = input.folderPath || ctx.memory.get('lastFolderPath');
    if (!folderPath) throw new Error('No folderPath. Ask the user to pick a folder.');

    // Decide which files to push.
    let candidates = ctx.scratch.lastFileSet;
    if (!candidates || candidates.length === 0) {
      candidates = await listFiles(folderPath);
    }
    if (input.fileNames && input.fileNames.length) {
      const set = new Set(input.fileNames);
      candidates = candidates.filter((f) => set.has(f.name));
    }
    if (!candidates.length) {
      return { ok: false, message: 'No files to upload.' };
    }

    ctx.log('info', `Preparing to upload ${candidates.length} file(s) to case ${caseUuid}.`);

    // ---- 1. Presigned URLs ----
    const presignedReq = {
      caseUuid,
      files: candidates.map((f) => ({
        folderName: FOLDER_NAME,
        fileName: f.name,
        mimeType: f.mimeType,
        size: f.size,
        fieldName: 'caseFiles',
      })),
    };
    ctx.log('info', `Requesting presigned URLs for: ${candidates.map((c) => c.name).join(', ')}`);
    const presignedResp = await ctx.api.post('/presigned-urls', presignedReq);
    // This backend wraps responses as { body: ... } (same as /create -> body.requestUuid).
    const payload = presignedResp.data?.body ?? presignedResp.data ?? {};
    const presigned =
      payload.urls ||
      payload.data ||
      payload.files ||
      payload.presignedUrls ||
      (Array.isArray(payload) ? payload : []);
    if (!Array.isArray(presigned) || presigned.length !== candidates.length) {
      throw new Error(
        `Presigned URL response shape unexpected. Got ${Array.isArray(presigned) ? presigned.length : typeof presigned} entries for ${candidates.length} files.`
      );
    }

    // Index by fileName so we don't depend on response order.
    const byName = new Map();
    for (const p of presigned) {
      const fname = p.fileName || p.name;
      const url = p.uploadUrl || p.url || p.presignedUrl;
      const blobPath = p.blobPath || `${caseUuid}/${FOLDER_NAME}/${fname}`;
      if (fname && url) byName.set(fname, { url, blobPath });
    }

    // ---- 2. Parallel uploads to Azure ----
    const concurrency = Math.max(1, parseInt(ctx.env.UPLOAD_CONCURRENCY, 10) || 4);
    const maxRetries = Math.max(1, parseInt(ctx.env.UPLOAD_MAX_RETRIES, 10) || 3);
    const limit = pLimit(concurrency);
    const results = [];
    let done = 0;

    await Promise.all(
      candidates.map((f) =>
        limit(async () => {
          const meta = byName.get(f.name);
          if (!meta) {
            results.push({ fileName: f.name, ok: false, error: 'no presigned url' });
            ctx.emitProgress({ fileName: f.name, status: 'error', error: 'no presigned url' });
            return;
          }
          ctx.emitProgress({ fileName: f.name, status: 'uploading', loaded: 0, total: f.size });
          try {
            await uploadOne({
              uploadUrl: meta.url,
              filePath: f.path,
              contentType: f.mimeType,
              maxRetries,
              onProgress: ({ loaded, total }) =>
                ctx.emitProgress({ fileName: f.name, status: 'uploading', loaded, total }),
            });
            results.push({ fileName: f.name, ok: true, blobPath: meta.blobPath });
            done++;
            ctx.emitProgress({ fileName: f.name, status: 'done', loaded: f.size, total: f.size });
            ctx.log('info', `Uploaded ${f.name} (${done}/${candidates.length})`);
          } catch (err) {
            results.push({ fileName: f.name, ok: false, error: err.message });
            ctx.emitProgress({ fileName: f.name, status: 'error', error: err.message });
            ctx.log('error', `Upload failed for ${f.name}: ${err.message}`);
          }
        })
      )
    );

    const successes = results.filter((r) => r.ok);
    if (!successes.length) {
      throw new Error('All uploads failed; not calling /add-file.');
    }

    // ---- 3. Register with backend ----
    ctx.log('info', `Registering ${successes.length} file(s) with case…`);
    const addReq = {
      requestUuid: caseUuid,
      caseFileTypes: '1',
      caseFiles: successes.map((s) => ({
        blobPath: s.blobPath,
        fileName: s.fileName,
      })),
    };
    const addResp = await ctx.api.post('/add-file', addReq);
    ctx.log('info', `Registered ${successes.length} file(s).`);

    return {
      caseUuid,
      uploaded: successes.map((s) => s.fileName),
      failed: results.filter((r) => !r.ok).map((r) => ({ fileName: r.fileName, error: r.error })),
      addFileResponse: addResp.data,
    };
  },
};
