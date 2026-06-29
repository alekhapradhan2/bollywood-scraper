// ─────────────────────────────────────────────────────────────────────────────
//  checkpoint.js — Persist and restore scraper progress across restarts
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("fs");
const path = require("path");
const { CHECKPOINT_FILE } = require("../config");
const logger = require("./logger");

const CHECKPOINT_PATH = path.resolve(__dirname, "../../", CHECKPOINT_FILE);

// Ensure directory exists
const dir = path.dirname(CHECKPOINT_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

/**
 * Default checkpoint structure.
 */
const DEFAULT = {
  version: 2,
  startedAt: null,
  lastUpdated: null,
  totalMovies: 0,          // total TMDB IDs discovered
  processedIds: [],        // TMDB IDs successfully saved/updated
  failedIds: [],           // TMDB IDs that failed after all retries
  skippedIds: [],          // TMDB IDs skipped (already up-to-date)
  currentYear: null,       // year currently being scraped
  currentPage: 1,          // TMDB page within that year
  stats: {
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    castCreated: 0,
    castReused: 0,
  },
};

function load() {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      const raw = fs.readFileSync(CHECKPOINT_PATH, "utf-8");
      const data = JSON.parse(raw);
      // Merge with defaults to handle new fields added in later versions
      return { ...DEFAULT, ...data, stats: { ...DEFAULT.stats, ...data.stats } };
    }
  } catch (err) {
    logger.warn("Checkpoint load failed — starting fresh.", { err: err.message });
  }
  return { ...DEFAULT, stats: { ...DEFAULT.stats } };
}

function save(cp) {
  try {
    cp.lastUpdated = new Date().toISOString();
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2), "utf-8");
  } catch (err) {
    logger.error("Checkpoint save failed!", { err: err.message });
  }
}

function markProcessed(cp, tmdbId) {
  if (!cp.processedIds.includes(tmdbId)) cp.processedIds.push(tmdbId);
  cp.failedIds = cp.failedIds.filter((id) => id !== tmdbId);
  cp.skippedIds = cp.skippedIds.filter((id) => id !== tmdbId);
}

function markFailed(cp, tmdbId) {
  if (!cp.failedIds.includes(tmdbId)) cp.failedIds.push(tmdbId);
}

function markSkipped(cp, tmdbId) {
  if (!cp.skippedIds.includes(tmdbId)) cp.skippedIds.push(tmdbId);
}

function isProcessed(cp, tmdbId) {
  return cp.processedIds.includes(tmdbId) || cp.skippedIds.includes(tmdbId);
}

function reset() {
  const fresh = { ...DEFAULT, stats: { ...DEFAULT.stats }, startedAt: new Date().toISOString() };
  save(fresh);
  return fresh;
}

module.exports = { load, save, markProcessed, markFailed, markSkipped, isProcessed, reset };
