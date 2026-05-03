'use strict';

const axios = require('axios');

/**
 * Performs the login HTTP call. We intentionally don't store the token here —
 * main.js encrypts it via safeStorage before persisting.
 *
 * Backends differ on response shape; we normalise common variants.
 */
async function login({ loginUrl, email, password, timeoutMs = 20_000 }) {
  if (!loginUrl) throw new Error('AUTH_LOGIN_URL is not configured.');
  if (!email || !password) throw new Error('Email and password are required.');

  let resp;
  try {
    resp = await axios.post(
      loginUrl,
      { email, password },
      { timeout: timeoutMs, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`Login failed: ${msg}`);
  }

  const data = resp.data.body || {};  

  const token =
    data.token ||
    data.accessToken ||
    data.jwt ||
    data?.data?.token ||
    data?.data?.accessToken;

  if (!token || typeof token !== 'string') {
    throw new Error('Login succeeded but no JWT was returned. Check AUTH_LOGIN_URL response shape.');
  }
  return { token, raw: data };
}

module.exports = { login };
