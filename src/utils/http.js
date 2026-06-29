// ─────────────────────────────────────────────────────────────────────────────
//  http.js — Axios wrapper with DNS override to bypass ISP blocks
//  Strategy: resolve api.themoviedb.org to a working IP directly,
//  bypassing ISP DNS pollution / SNI blocking
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const axios = require("axios");
const https = require("https");
const dns = require("dns");
const { RETRY_ATTEMPTS, RETRY_DELAY_MS, REQUEST_TIMEOUT_MS, POLITE_DELAY_MS } = require("../config");
const logger = require("./logger");

// ── Force Google DNS (8.8.8.8) to resolve hostnames
// This bypasses ISP DNS blocking
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

// ── Custom HTTPS agent that skips certificate issues and uses Google DNS
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false, // handle any cert issues
  family: 4, // force IPv4
  lookup: (hostname, options, callback) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err) {
        return dns.lookup(hostname, options, callback);
      }
      callback(null, addresses[0], 4);
    });
  }
});

// ── Optional proxy from env
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";

// Per-domain last-request timestamps
const _lastRequest = {};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

async function get(url, opts = {}) {
  const domain = getDomain(url);
  const now = Date.now();
  const lastMs = _lastRequest[domain] || 0;
  const wait = POLITE_DELAY_MS - (now - lastMs);
  if (wait > 0) await sleep(wait);

  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      _lastRequest[domain] = Date.now();

      const config = {
        timeout: REQUEST_TIMEOUT_MS,
        httpsAgent,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json, text/html, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
        },
        ...opts,
      };

      // If proxy set in env, use it
      if (PROXY_URL) {
        const { HttpsProxyAgent } = require("https-proxy-agent");
        config.httpsAgent = new HttpsProxyAgent(PROXY_URL);
        config.proxy = false;
      }

      const res = await axios.get(url, config);
      return res;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status && status !== 429 && status < 500) {
        logger.warn(`HTTP ${status} for ${url} — not retrying`);
        throw err;
      }
      if (attempt < RETRY_ATTEMPTS) {
        const delay = RETRY_DELAY_MS * attempt;
        logger.warn(`Attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms…`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

async function getJSON(url, opts = {}) {
  const res = await get(url, opts);
  return res.data;
}

async function getHTML(url, opts = {}) {
  const res = await get(url, { responseType: "text", ...opts });
  return res.data;
}

module.exports = { get, getJSON, getHTML, sleep };