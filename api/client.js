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
      const url = err.config?.url;
      const method = (err.config?.method || 'GET').toUpperCase();

      // Surface as much detail as we can, so 400s actually tell you which
      // field the backend disliked.
      const baseMsg = body?.message || body?.body?.message || body?.error || err.message || 'API request failed.';
      const validation =
        body?.errors || body?.body?.errors || body?.validation || body?.body?.validation || null;

      let detail = '';
      if (validation) {
        try { detail = ' :: ' + JSON.stringify(validation).slice(0, 600); } catch { /* noop */ }
      } else if (body && typeof body === 'object') {
        // Drop a compact dump of unknown shapes so we can debug without a network tap.
        try { detail = ' :: ' + JSON.stringify(body).slice(0, 600); } catch { /* noop */ }
      }

      // Echo the request body too — invaluable when the backend just says "invalid".
      let reqDump = '';
      if (err.config?.data) {
        try {
          const raw = typeof err.config.data === 'string' ? err.config.data : JSON.stringify(err.config.data);
          reqDump = ' :: req=' + raw.slice(0, 600);
        } catch { /* noop */ }
      }

      const e = new Error(`[API ${status || 'NETWORK'} ${method} ${url}] ${baseMsg}${detail}${reqDump}`);
      e.status = status;
      e.body = body;
      e.cause = err;
      throw e;
    }
  );

  return instance;
}

module.exports = { buildClient };
