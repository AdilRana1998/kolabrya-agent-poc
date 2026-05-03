'use strict';

const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');

/**
 * PUT a single file to an Azure Block Blob URL. Retries with exponential
 * backoff on 5xx + network errors. Calls `onProgress({loaded,total})` as
 * bytes flush.
 */
async function uploadOne({ uploadUrl, filePath, contentType, maxRetries = 3, onProgress }) {
  if (!uploadUrl) throw new Error('Missing uploadUrl');
  const stat = await fsp.stat(filePath);
  const total = stat.size;

  let attempt = 0;
  let lastErr;
  while (attempt < maxRetries) {
    attempt++;
    try {
      // Stream the file so we don't pull huge buffers into memory.
      const stream = fs.createReadStream(filePath);

      let loaded = 0;
      stream.on('data', (chunk) => {
        loaded += chunk.length;
        if (onProgress) {
          try { onProgress({ loaded, total }); } catch { /* noop */ }
        }
      });

      const headers = {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': total,
      };

      await axios.put(uploadUrl, stream, {
        headers,
        // Disable axios' progress (we handle it from the stream); allow large bodies.
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 0,
      });

      if (onProgress) onProgress({ loaded: total, total });
      return { ok: true, attempt };
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retriable = !status || (status >= 500 && status < 600) || status === 408 || status === 429;
      if (!retriable || attempt >= maxRetries) break;
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  const status = lastErr?.response?.status || 'NETWORK';
  throw new Error(`Azure upload failed after ${attempt} attempt(s) [${status}]: ${lastErr?.message || lastErr}`);
}

module.exports = { uploadOne };
