// ─────────────────────────────────────────────────────────────────────────────
//  normalizer.js — Data cleaning, normalization, and validation helpers
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

/**
 * Generate a URL-safe slug from a title + year.
 * Mirrors the makeMovieSlug() function in server.js exactly.
 */
function makeSlug(title, releaseDate) {
  const year = releaseDate ? new Date(releaseDate).getFullYear() : "";
  const base = String(title || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
  return year ? `${base}-${year}` : base;
}

/**
 * Clean plain text — trim, collapse whitespace, remove HTML tags.
 */
function cleanText(s) {
  if (!s) return "";
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a person name — title-case, trim extra spaces.
 */
function normalizeName(s) {
  if (!s) return "";
  return String(s)
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Validate a URL — returns the URL if valid, "" otherwise.
 */
function validateUrl(s) {
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : "";
  } catch { return ""; }
}

/**
 * Extract bare YouTube ID from any YouTube URL or bare ID.
 */
function extractYtId(input) {
  if (!input) return "";
  const s = String(input).trim();
  const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return "";
}

/**
 * Deduplicate array of objects by a key function.
 */
function dedupeBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((item) => {
    const k = keyFn(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Parse a runtime string like "2h 15m", "135 min", "135" → minutes as number.
 */
function parseRuntime(s) {
  if (!s) return 0;
  const str = String(s);
  const hm = str.match(/(\d+)\s*h\s*(\d+)?\s*m?/i);
  if (hm) return parseInt(hm[1]) * 60 + (parseInt(hm[2]) || 0);
  const mins = str.match(/(\d+)\s*min/i);
  if (mins) return parseInt(mins[1]);
  const bare = parseInt(str);
  return isNaN(bare) ? 0 : bare;
}

/**
 * Format runtime from minutes to "Xh Ym" string.
 */
function formatRuntime(minutes) {
  if (!minutes || isNaN(minutes)) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Normalize genre strings — capitalize, remove dupes.
 */
function normalizeGenres(genres) {
  if (!Array.isArray(genres)) return [];
  return [...new Set(
    genres
      .map((g) => String(g).trim())
      .filter(Boolean)
      .map((g) => g.charAt(0).toUpperCase() + g.slice(1).toLowerCase())
  )];
}

/**
 * Convert TMDB/OMDb date "YYYY-MM-DD" or "DD MMM YYYY" to ISO "YYYY-MM-DD".
 */
function normalizeDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Calculate confidence score for a field value given its source.
 */
function confidence(source, value, fieldWeights) {
  if (!value || value === "" || value === "N/A") return 0;
  return fieldWeights[source] || 0.5;
}

/**
 * Merge field values from multiple sources, picking the highest-confidence non-empty value.
 * @param {Array<{value:any, source:string, conf:number}>} candidates
 * @returns best value
 */
function pickBest(candidates) {
  const valid = candidates.filter((c) => {
    const v = c.value;
    if (v === null || v === undefined || v === "" || v === "N/A") return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  });
  if (valid.length === 0) return null;
  valid.sort((a, b) => b.conf - a.conf);
  return valid[0].value;
}

/**
 * Strip and clean HTML to plain synopsis text.
 */
function htmlToPlain(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Convert a currency string (budget/collection) to INR rupees integer.
 * Handles $, £, ₹, Cr, L, million, billion.
 */
function parseCurrencyToINR(str) {
  if (!str) return 0;
  const s = String(str).replace(/[,\s]/g, "").toLowerCase();
  let n = parseFloat(s.replace(/[^0-9.]/g, ""));
  if (isNaN(n)) return 0;

  // USD → INR approximate (1 USD ≈ 83 INR)
  const isUSD = str.includes("$");
  const isGBP = str.includes("£");
  const rate = isUSD ? 83 : isGBP ? 105 : 1;

  if (s.includes("billion")) n *= 1_00_00_00_000;
  else if (s.includes("million")) n *= 10_00_000;
  else if (s.includes("crore") || s.includes("cr")) n *= 1_00_00_000;
  else if (s.includes("lakh") || s.includes("lac")) n *= 1_00_000;
  else if (n < 1000) return 0; // bare small number — discard

  return Math.round(n * rate);
}

/**
 * Format INR integer → "₹X.XX Cr"
 */
function formatINR(n) {
  if (!n || isNaN(n)) return "TBA";
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(2)} Cr`;
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(2)} L`;
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

module.exports = {
  makeSlug,
  cleanText,
  normalizeName,
  validateUrl,
  extractYtId,
  dedupeBy,
  parseRuntime,
  formatRuntime,
  normalizeGenres,
  normalizeDate,
  confidence,
  pickBest,
  htmlToPlain,
  parseCurrencyToINR,
  formatINR,
};
