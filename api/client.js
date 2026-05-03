'use strict';

const axios = require('axios');

/**
 * Build an axios instance bound to API_BASE_URL with a JWT getter.
 * `tokenProvider` is a function that returns the current decrypted token (or
 * null if logged out). Calling it on every request means token rotation /
 * logout takes effect immediately.
 */
function buildClient({ baseURL, tokenProvider, timeoutMs = 30_000 }) {
  if (!baseURL) throw new Error('API_BASE_URL is not configured.');
  const instance = axios.create({ baseURL, timeout: timeoutMs });

  instance.interceptors.request.use((cfg) => {
    const token = tokenProvider && tokenProvider();
    if (token) cfg.headers.Authorization = `Bearer ${token}`;
    cfg.headers['Content-Type'] = cfg.headers['Content-Type'] || 'application/json';
    return cfg;
  });

  instance.interceptors.response.use(
    (r) => r,
    (err) => {
      // Normalise the error so callers don't have to crawl axios internals.
      const status = err.response?.status;
      const body = err.response?.data;
      const msg = body?.message || err.message || 'API request failed.';
      const e = new Error(`[API ${status || 'NETWORK'}] ${msg}`);
      e.status = status;
      e.body = body;
      e.cause = err;
      throw e;
    }
  );

  return instance;
}

module.exports = { buildClient };
