// -----------------------------------------------------------------------------
//  orchestrator-bengali.js - Bengali movie scraper orchestrator
//  Mirrors orchestrator.js but scrapes Bengali (bn) movies from 2000 to present.
//  Uses its own checkpoint file (checkpoints/bengali-progress.json).
//  No auto-created production house - uses BENGALI_SCRAPER_PRODUCTION_ID or
//  falls back to SCRAPER_PRODUCTION_ID from env. Passes null if neither is set.
// -----------------------------------------------------------------------------
"use strict";

const pLimit = require("p-limit");
const mongoose = require("mongoose");
const {
  BENGALI_START_YEAR,
  END_YEAR,
  TMDB_CONCURRENCY,
  BATCH_SIZE,
  BENGALI_SCRAPER_PRODUCTION_ID,
  SCRAPER_PRODUCTION_ID,
  BENGALI_CHECKPOINT_FILE,
} = require("./config");
const { fetchAllBengaliMoviesByYear, fetchAllRecentBengaliMovies } = require("./scrapers/tmdb-bengali");
const { processMovie } = require("./queue/processor");
const logger = require("./utils/logger");
const { sleep } = require("./utils/http");
const fs = require("fs");
const path = require("path");

// Custom checkpoint for Bengali (isolated from Bollywood checkpoint)
// __dirname is src/, so go up one level to reach project root where checkpoints/ lives
const BENGALI_CHECKPOINT_PATH = path.resolve(__dirname, "../", BENGALI_CHECKPOINT_FILE);
const Bengali_CP_DIR = path.dirname(BENGALI_CHECKPOINT_PATH);
if (!fs.existsSync(Bengali_CP_DIR)) fs.mkdirSync(Bengali_CP_DIR, { recursive: true });

const DEFAULT_CHECKPOINT = {
  version: 2,
  startedAt: null,
  lastUpdated: null,
  totalMovies: 0,
  processedIds: [],
  failedIds: [],
  skippedIds: [],
  currentYear: null,
  currentPage: 1,
  stats: {
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    castCreated: 0,
    castReused: 0,
  },
};

function loadCheckpoint() {
  try {
    if (fs.existsSync(BENGALI_CHECKPOINT_PATH)) {
      const raw = fs.readFileSync(BENGALI_CHECKPOINT_PATH, "utf-8");
      const data = JSON.parse(raw);
      return { ...DEFAULT_CHECKPOINT, ...data, stats: { ...DEFAULT_CHECKPOINT.stats, ...data.stats } };
    }
  } catch (err) {
    logger.warn("Bengali checkpoint load failed - starting fresh.", { err: err.message });
  }
  return { ...DEFAULT_CHECKPOINT, stats: { ...DEFAULT_CHECKPOINT.stats } };
}

function saveCheckpoint(cp) {
  try {
    cp.lastUpdated = new Date().toISOString();
    fs.writeFileSync(BENGALI_CHECKPOINT_PATH, JSON.stringify(cp, null, 2), "utf-8");
  } catch (err) {
    logger.error("Bengali checkpoint save failed!", { err: err.message });
  }
}

function resetCheckpoint() {
  const fresh = { ...DEFAULT_CHECKPOINT, stats: { ...DEFAULT_CHECKPOINT.stats }, startedAt: new Date().toISOString() };
  saveCheckpoint(fresh);
  return fresh;
}

function isBengaliProcessed(cp, tmdbId) {
  return cp.processedIds.includes(tmdbId) || cp.skippedIds.includes(tmdbId);
}

function markBengaliProcessed(cp, tmdbId) {
  if (!cp.processedIds.includes(tmdbId)) cp.processedIds.push(tmdbId);
  cp.failedIds = cp.failedIds.filter((id) => id !== tmdbId);
  cp.skippedIds = cp.skippedIds.filter((id) => id !== tmdbId);
}

function markBengaliFailed(cp, tmdbId) {
  if (!cp.failedIds.includes(tmdbId)) cp.failedIds.push(tmdbId);
}

function markBengaliSkipped(cp, tmdbId) {
  if (!cp.skippedIds.includes(tmdbId)) cp.skippedIds.push(tmdbId);
}

// p-limit concurrency limiter
const limit = pLimit(TMDB_CONCURRENCY);

/**
 * Resolve production ID: BENGALI_SCRAPER_PRODUCTION_ID > SCRAPER_PRODUCTION_ID > null.
 * No auto-creation of production house.
 */
function resolveProductionId() {
  if (BENGALI_SCRAPER_PRODUCTION_ID && mongoose.isValidObjectId(BENGALI_SCRAPER_PRODUCTION_ID)) {
    logger.info(`Bengali scraper using BENGALI_SCRAPER_PRODUCTION_ID: ${BENGALI_SCRAPER_PRODUCTION_ID}`);
    return BENGALI_SCRAPER_PRODUCTION_ID;
  }
  if (SCRAPER_PRODUCTION_ID && mongoose.isValidObjectId(SCRAPER_PRODUCTION_ID)) {
    logger.info(`Bengali scraper falling back to SCRAPER_PRODUCTION_ID: ${SCRAPER_PRODUCTION_ID}`);
    return SCRAPER_PRODUCTION_ID;
  }
  logger.warn("No valid production ID set for Bengali scraper - movies will have no productionId.");
  return null;
}

/**
 * Run the Bengali scraper for a specific year range.
 *
 * @param {object} opts
 * @param {number} [opts.startYear]    - override BENGALI_START_YEAR (default: 2000)
 * @param {number} [opts.endYear]      - override END_YEAR
 * @param {boolean} [opts.reset]       - wipe checkpoint and start fresh
 * @param {boolean} [opts.retryFailed] - only retry previously failed IDs
 * @param {boolean} [opts.recent]      - only scrape last 6 months
 */
async function runBengali(opts = {}) {
  const startYear = opts.startYear || BENGALI_START_YEAR;
  const endYear = opts.endYear || END_YEAR;
  const doReset = opts.reset || false;
  const retryFailed = opts.retryFailed || false;
  const doRecent = opts.recent || false;

  logger.info("=================================================");
  logger.info(`  Bengali Movie Scraper - ${startYear} to ${endYear}`);
  logger.info("=================================================");

  // Connect to MongoDB
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGO_URI);
    logger.info("MongoDB connected (Bengali scraper)");
  }

  // Resolve production ID (no auto-creation)
  const productionId = resolveProductionId();

  // Load or reset checkpoint
  let checkpoint = doReset ? resetCheckpoint() : loadCheckpoint();
  if (!checkpoint.startedAt) {
    checkpoint.startedAt = new Date().toISOString();
    saveCheckpoint(checkpoint);
  }

  logger.info("Bengali checkpoint loaded", {
    processed: checkpoint.processedIds.length,
    failed: checkpoint.failedIds.length,
    skipped: checkpoint.skippedIds.length,
  });

  // Mode: retry failed only
  if (retryFailed) {
    await retryFailedBengaliMovies(checkpoint, productionId);
    return checkpoint.stats;
  }

  // Mode: recent (last 6 months)
  if (doRecent) {
    logger.info("\n---- Mode: Recent Bengali (Last 6 Months) ----");
    const movies = await fetchAllRecentBengaliMovies();
    logger.info(`Found ${movies.length} recent Bengali movies`);
    checkpoint.totalMovies += movies.length;
    saveCheckpoint(checkpoint);
    await processBengaliBatch(movies, checkpoint, productionId);
  } else {
    // Main year loop
    for (let year = startYear; year <= endYear; year++) {
      logger.info(`\n---- Bengali Year: ${year} ----`);
      checkpoint.currentYear = year;
      saveCheckpoint(checkpoint);

      const movies = await fetchAllBengaliMoviesByYear(year);
      logger.info(`Found ${movies.length} Bengali movies for ${year}`);
      checkpoint.totalMovies += movies.length;
      saveCheckpoint(checkpoint);

      await processBengaliBatch(movies, checkpoint, productionId);
    }
  }

  logger.info("\n=================================================");
  logger.info("  Bengali Scraper completed!");
  printBengaliFinalStats(checkpoint.stats);
  logger.info("=================================================\n");

  return checkpoint.stats;
}

/**
 * Helper: process an array of Bengali movies in batches.
 */
async function processBengaliBatch(movies, checkpoint, productionId) {
  const pending = movies.filter((m) => !isBengaliProcessed(checkpoint, m.id));
  logger.info(`Bengali pending: ${pending.length} (${movies.length - pending.length} already done)`);

  if (pending.length === 0) return;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    logger.info(`Bengali batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pending.length / BATCH_SIZE)} - ${batch.length} movies`);

    const results = await Promise.all(
      batch.map((movie) =>
        limit(() => processMovie({ ...movie, _language: "Bengali" }, productionId, checkpoint.stats))
      )
    );

    for (const result of results) {
      if (!result.tmdbId) continue;
      if (result.action === "inserted" || result.action === "updated") {
        markBengaliProcessed(checkpoint, result.tmdbId);
      } else if (result.action === "failed") {
        markBengaliFailed(checkpoint, result.tmdbId);
      } else if (result.action === "skipped") {
        markBengaliSkipped(checkpoint, result.tmdbId);
      }
    }

    saveCheckpoint(checkpoint);
    printBengaliProgress(checkpoint);
    await sleep(500);
  }
}

/**
 * Re-run pipeline only for previously failed Bengali TMDB IDs.
 */
async function retryFailedBengaliMovies(checkpoint, productionId) {
  const failedIds = [...checkpoint.failedIds];
  if (failedIds.length === 0) {
    logger.info("No failed Bengali movies to retry.");
    return;
  }
  logger.info(`Retrying ${failedIds.length} failed Bengali movies...`);

  for (const tmdbId of failedIds) {
    const result = await processMovie({ id: tmdbId, _language: "Bengali" }, productionId, checkpoint.stats)
      .catch((err) => ({ action: "failed", reason: err.message, tmdbId }));

    if (result.action !== "failed") {
      markBengaliProcessed(checkpoint, tmdbId);
    }
    saveCheckpoint(checkpoint);
    await sleep(300);
  }
}

/**
 * Run incremental Bengali update - only recent movies (last 6 months).
 * Called by the nightly cron job at 5 AM IST.
 */
async function runBengaliIncremental() {
  return runBengali({ recent: true });
}

function printBengaliProgress(cp_) {
  const s = cp_.stats;
  logger.info(`Bengali progress - inserted:${s.inserted} updated:${s.updated} skipped:${s.skipped} failed:${s.failed} | cast created:${s.castCreated} reused:${s.castReused}`);
}

function printBengaliFinalStats(stats) {
  logger.info(`  Inserted:     ${stats.inserted}`);
  logger.info(`  Updated:      ${stats.updated}`);
  logger.info(`  Skipped:      ${stats.skipped}`);
  logger.info(`  Failed:       ${stats.failed}`);
  logger.info(`  Cast created: ${stats.castCreated}`);
  logger.info(`  Cast reused:  ${stats.castReused}`);
}

module.exports = { runBengali, runBengaliIncremental };
