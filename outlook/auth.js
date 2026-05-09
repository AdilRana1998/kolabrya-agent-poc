'use strict';

/**
 * Microsoft Identity (Azure AD) authentication for desktop.
 *
 * Strategy: OAuth 2.0 Authorization Code with PKCE via MSAL Node's
 * PublicClientApplication. We spin up a tiny loopback HTTP server, open the
 * Microsoft sign-in URL in the user's default browser, capture the auth code
 * on redirect, exchange it for tokens, and persist the resulting account so
 * subsequent silent token acquisitions work via the refresh token.
 *
 * Why not the BrowserWindow trick? Loopback is the path Microsoft documents
 * for desktop apps and avoids embedded-webview SSO breakage.
 */

const http = require('http');
const url = require('url');
const crypto = require('crypto');
const { shell, safeStorage } = require('electron');
const msal = require('@azure/msal-node');

const memoryStore = require('../db/memory-store');

const ACCOUNT_STORAGE_KEY = 'msgraph_account_homeId';
const TOKEN_CACHE_STORAGE_KEY = 'msgraph_token_cache_v1';

let pca = null;          // PublicClientApplication singleton
let cachedAccount = null; // last-known msal account record

function _scopes() {
  return (process.env.MSGRAPH_SCOPES || 'offline_access,Mail.Read,Mail.ReadWrite,Mail.Send,User.Read')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function _redirectUri() {
  return process.env.MSGRAPH_REDIRECT_URI || 'http://localhost:53682/auth/callback';
}

function _authority() {
  const tenant = process.env.MSGRAPH_TENANT_ID || 'common';
  return `https://login.microsoftonline.com/${tenant}`;
}

/**
 * Encrypted on-disk persistence for MSAL's serialized token cache. Survives
 * restarts so the user only signs in once.
 */
const cachePlugin = {
  async beforeCacheAccess(ctx) {
    try {
      const blob = memoryStore.getMemory(TOKEN_CACHE_STORAGE_KEY);
      if (blob && safeStorage.isEncryptionAvailable()) {
        const decrypted = safeStorage.decryptString(Buffer.from(blob, 'base64'));
        ctx.tokenCache.deserialize(decrypted);
      }
    } catch {
      /* corrupt cache: start fresh */
    }
  },
  async afterCacheAccess(ctx) {
    if (!ctx.cacheHasChanged) return;
    if (!safeStorage.isEncryptionAvailable()) return;
    const serialized = ctx.tokenCache.serialize();
    const encrypted = safeStorage.encryptString(serialized).toString('base64');
    memoryStore.setMemory(TOKEN_CACHE_STORAGE_KEY, encrypted);
  },
};

function _getPca() {
  if (pca) return pca;
  const clientId = process.env.MSGRAPH_CLIENT_ID;
  if (!clientId) {
    throw new Error('MSGRAPH_CLIENT_ID is not configured. See README.outlook.md.');
  }
  pca = new msal.PublicClientApplication({
    auth: {
      clientId,
      authority: _authority(),
    },
    cache: { cachePlugin },
    system: {
      loggerOptions: {
        // Logs go nowhere by default; flip to console for debugging.
        loggerCallback() {},
        piiLoggingEnabled: false,
        logLevel: msal.LogLevel.Warning,
      },
    },
  });
  return pca;
}

function _redirectPort() {
  // Parse the port from MSGRAPH_REDIRECT_URI; default 53682.
  try {
    const u = new URL(_redirectUri());
    return parseInt(u.port, 10) || 53682;
  } catch {
    return 53682;
  }
}

/**
 * Run an interactive sign-in. Returns the AccountInfo on success.
 * Throws on cancel / timeout / Microsoft error.
 */
async function interactiveSignIn({ timeoutMs = 5 * 60 * 1000 } = {}) {
  const client = _getPca();
  const scopes = _scopes();
  const redirectUri = _redirectUri();
  const port = _redirectPort();
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    let server;
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      try { server && server.close(); } catch { /* noop */ }
      fn(val);
    };

    const timer = setTimeout(
      () => finish(reject, new Error('Sign-in timed out.')),
      timeoutMs
    );

    server = http.createServer(async (req, res) => {
      try {
        const parsed = url.parse(req.url, true);
        if (!parsed.pathname.startsWith(new URL(redirectUri).pathname)) {
          res.writeHead(404); res.end('Not found'); return;
        }
        const { code, state: gotState, error, error_description: errDesc } = parsed.query;
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h2>Sign-in failed</h2><p>${error}: ${errDesc || ''}</p>`);
          clearTimeout(timer);
          finish(reject, new Error(`AAD error: ${error} ${errDesc || ''}`));
          return;
        }
        if (!code || gotState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h2>Sign-in failed</h2><p>Missing code or state mismatch.</p>');
          clearTimeout(timer);
          finish(reject, new Error('Auth callback missing code or bad state.'));
          return;
        }

        const tokenResp = await client.acquireTokenByCode({
          code,
          scopes,
          redirectUri,
        });

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<!doctype html><meta charset="utf-8"><title>Signed in</title>' +
          '<body style="font-family:system-ui;padding:32px;background:#f7f7f5;color:#1f1f1f">' +
          '<h2>Signed in to Outlook ✓</h2>' +
          '<p>You can close this tab and return to Kolabrya Agent.</p>' +
          '</body>'
        );
        clearTimeout(timer);
        cachedAccount = tokenResp.account;
        if (cachedAccount?.homeAccountId) {
          memoryStore.setMemory(ACCOUNT_STORAGE_KEY, cachedAccount.homeAccountId);
        }
        finish(resolve, tokenResp.account);
      } catch (err) {
        try {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h2>Sign-in failed</h2><pre>${String(err.message || err)}</pre>`);
        } catch { /* noop */ }
        clearTimeout(timer);
        finish(reject, err);
      }
    });

    server.on('error', (err) => {
      clearTimeout(timer);
      finish(reject, new Error(`Loopback server error on port ${port}: ${err.message}`));
    });

    server.listen(port, '127.0.0.1', async () => {
      try {
        const authUrl = await client.getAuthCodeUrl({
          scopes,
          redirectUri,
          state,
          prompt: 'select_account',
        });
        await shell.openExternal(authUrl);
      } catch (err) {
        clearTimeout(timer);
        finish(reject, err);
      }
    });
  });
}

/**
 * Get an access token without prompting if possible (refresh-token flow).
 * Triggers an interactive sign-in if no account is cached or silent fails.
 */
async function getAccessToken({ allowInteractive = false } = {}) {
  const client = _getPca();
  const scopes = _scopes();

  // Find a cached account.
  if (!cachedAccount) {
    const homeId = memoryStore.getMemory(ACCOUNT_STORAGE_KEY);
    if (homeId) {
      const accounts = await client.getTokenCache().getAllAccounts();
      cachedAccount = accounts.find((a) => a.homeAccountId === homeId) || null;
    }
  }

  if (cachedAccount) {
    try {
      const r = await client.acquireTokenSilent({ account: cachedAccount, scopes });
      return r.accessToken;
    } catch (err) {
      if (!allowInteractive) {
        throw new Error(`Silent token acquisition failed: ${err.message}. Sign in again.`);
      }
    }
  }

  if (!allowInteractive) {
    throw new Error('Not signed in to Outlook.');
  }

  await interactiveSignIn();
  if (!cachedAccount) {
    throw new Error('Sign-in completed but no account was cached. Please try again.');
  }
  const r = await client.acquireTokenSilent({ account: cachedAccount, scopes });
  return r.accessToken;
}

async function status() {
  const client = _getPca();
  let account = cachedAccount;
  if (!account) {
    const homeId = memoryStore.getMemory(ACCOUNT_STORAGE_KEY);
    if (homeId) {
      const accounts = await client.getTokenCache().getAllAccounts();
      account = accounts.find((a) => a.homeAccountId === homeId) || null;
    }
  }
  return {
    connected: !!account,
    username: account?.username || null,
    name: account?.name || null,
  };
}

async function signOut() {
  const client = _getPca();
  const homeId = memoryStore.getMemory(ACCOUNT_STORAGE_KEY);
  if (homeId) {
    try {
      const cache = client.getTokenCache();
      const accounts = await cache.getAllAccounts();
      const acct = accounts.find((a) => a.homeAccountId === homeId);
      if (acct) await cache.removeAccount(acct);
    } catch { /* noop */ }
  }
  memoryStore.setMemory(ACCOUNT_STORAGE_KEY, null);
  memoryStore.setMemory(TOKEN_CACHE_STORAGE_KEY, null);
  cachedAccount = null;
}

module.exports = { interactiveSignIn, getAccessToken, status, signOut };
