'use strict';

/**
 * Thin axios wrapper for Microsoft Graph (https://graph.microsoft.com/v1.0).
 *
 *  - Token is fetched fresh on every request via outlook/auth.getAccessToken,
 *    so refreshes happen transparently.
 *  - 401 once -> retry once with a forced refresh.
 *  - 429 / 503 -> respect Retry-After, retry up to 3 times with backoff.
 *  - Errors are normalised into Error objects whose `.status` and `.body`
 *    are useful at the call site.
 */

const axios = require('axios');
const { getAccessToken } = require('./auth');

const BASE = 'https://graph.microsoft.com/v1.0';

async function _retryableSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _normaliseErr(err, label) {
  const status = err.response?.status;
  const body = err.response?.data;
  const msg =
    body?.error?.message ||
    body?.message ||
    err.message ||
    'Graph request failed.';
  const out = new Error(`[Graph ${status || 'NETWORK'} ${label}] ${msg}`);
  out.status = status;
  out.body = body;
  out.cause = err;
  return out;
}

async function request({ method = 'GET', urlPath, params, data, headers, responseType, timeoutMs = 60_000 }) {
  const isAbsolute = /^https?:\/\//i.test(urlPath);
  const fullUrl = isAbsolute ? urlPath : `${BASE}${urlPath.startsWith('/') ? '' : '/'}${urlPath}`;

  let token = await getAccessToken();
  let attempt = 0;
  let last;

  while (attempt < 4) {
    attempt++;
    try {
      return await axios({
        method,
        url: fullUrl,
        params,
        data,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(headers || {}),
        },
        responseType: responseType || 'json',
        timeout: timeoutMs,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
    } catch (err) {
      last = err;
      const status = err.response?.status;
      // Token might have just rotated under us.
      if (status === 401 && attempt === 1) {
        token = await getAccessToken();
        continue;
      }
      if (status === 429 || status === 503) {
        const ra = parseInt(err.response.headers?.['retry-after'], 10);
        const wait = (Number.isFinite(ra) ? ra : Math.min(8, 2 ** attempt)) * 1000;
        await _retryableSleep(wait);
        continue;
      }
      if (!status) {
        // Network — backoff once.
        if (attempt < 3) { await _retryableSleep(500 * attempt); continue; }
      }
      break;
    }
  }
  throw _normaliseErr(last, `${method} ${urlPath}`);
}

const get = (urlPath, params) => request({ method: 'GET', urlPath, params });
const post = (urlPath, data) => request({ method: 'POST', urlPath, data });
const patch = (urlPath, data) => request({ method: 'PATCH', urlPath, data });
const del = (urlPath) => request({ method: 'DELETE', urlPath });

/** Fetch raw bytes (e.g. attachment $value). Returns Buffer. */
async function getBytes(urlPath) {
  const resp = await request({ method: 'GET', urlPath, responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}

module.exports = { request, get, post, patch, del, getBytes };
