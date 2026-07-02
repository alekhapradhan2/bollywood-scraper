// ─────────────────────────────────────────────────────────────────────────────
//  orchestrator.js — Main scraper orchestrator
//  Drives year-by-year TMDB discovery → concurrent pipeline → checkpoint saves
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const pLimit = require("p-limit");
const mongoose = require("mongoose");
const { START_YEAR, END_YEAR, TMDB_CONCURRENCY, BATCH_SIZE, SCRAPER_PRODUCTION_ID } = require("./config");
const { fetchAllMoviesByYear, fetchAllRecentMovies } = require("./scrapers/tmdb");
const { processMovie } = require("./queue/processor");
const cp = require("./utils/checkpoint");
const logger = require("./utils/logger");
const { sleep } = require("./utils/http");

// ── p-limit concurrency limiter
const limit = pLimit(TMDB_CONCURRENCY);

/**
 * Ensure the scraper production house exists in the DB.
 * If SCRAPER_PRODUCTION_ID is not set, create one automatically.
 */
async function ensureProductionId() {
  let prodId = SCRAPER_PRODUCTION_ID;
  if (prodId && mongoose.isValidObjectId(prodId)) {
    logger.info(`Using scraper production ID: ${prodId}`);
    return prodId;
  }

  // Try to find or create a "Bollywood Auto-Import" production
  const Production = mongoose.models.Production || require("./models/Production");
  let prod = await Production.findOne({ name: "Bollywood Auto-Import" }).lean();
  if (!prod) {
    prod = await Production.create({
      name: "Bollywood Auto-Import",
      email: "scraper@bollywood-autoimport.local",
      password: "scraper-no-login",
      bio: "Automatically imported Bollywood movie data",
      website: "https://ollypedia.in",
    });
    logger.info(`Created scraper production: ${prod._id}`);
  }
  return String(prod._id);
}

/**
 * Run the scraper for a specific year range.
 *
 * @param {object} opts
 * @param {number} [opts.startYear]  — override START_YEAR
 * @param {number} [opts.endYear]    — override END_YEAR
 * @param {boolean} [opts.reset]     — wipe checkpoint and start fresh
 * @param {boolean} [opts.retryFailed] — only retry previously failed IDs
 */
async function run(opts = {}) {
  const startYear = opts.startYear || START_YEAR;
  const endYear = opts.endYear || END_YEAR;
  const doReset = opts.reset || false;
  const retryFailed = opts.retryFailed || false;
  const doRecent = opts.recent || false;

  logger.info(`═══════════════════════════════════════════════`);
  logger.info(`  Bollywood Scraper — ${startYear} to ${endYear}`);
  logger.info(`═══════════════════════════════════════════════`);

  // ── Connect to MongoDB
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGO_URI);
    logger.info("MongoDB connected");
  }

  // ── Ensure production house
  const productionId = await ensureProductionId();

  // ── Load or reset checkpoint
  let checkpoint = doReset ? cp.reset() : cp.load();
  if (!checkpoint.startedAt) {
    checkpoint.startedAt = new Date().toISOString();
    cp.save(checkpoint);
  }

  logger.info("Checkpoint loaded", {
    processed: checkpoint.processedIds.length,
    failed: checkpoint.failedIds.length,
    skipped: checkpoint.skippedIds.length,
  });

  // ── Mode: retry failed only
  if (retryFailed) {
    await retryFailedMovies(checkpoint, productionId);
    return checkpoint.stats;
  }

  const tmdbIds = opts.tmdbIds || [];

  // ── Mode: specific TMDB IDs
  if (tmdbIds.length > 0) {
    logger.info(`\n──── Mode: Specific TMDB IDs ────`);
    const movies = tmdbIds.map(id => ({ id }));
    checkpoint.totalMovies += movies.length;
    cp.save(checkpoint);
    await processBatchOfMovies(movies, checkpoint, productionId);
  } else if (doRecent) {
    logger.info(`\n──── Mode: Recent (Last 6 Months) ────`);
    const movies = await fetchAllRecentMovies();
    logger.info(`Found ${movies.length} recent movies`);
    checkpoint.totalMovies += movies.length;
    cp.save(checkpoint);
    await processBatchOfMovies(movies, checkpoint, productionId);
  } else {
    // ── Main year loop
    for (let year = startYear; year <= endYear; year++) {
      logger.info(`\n──── Year: ${year} ────`);
      checkpoint.currentYear = year;
      cp.save(checkpoint);

      // Fetch all TMDB IDs for this year
      const movies = await fetchAllMoviesByYear(year);
      logger.info(`Found ${movies.length} movies for ${year}`);
      checkpoint.totalMovies += movies.length;
      cp.save(checkpoint);

      await processBatchOfMovies(movies, checkpoint, productionId);
    }
  }

  logger.info("\n═══════════════════════════════════════════════");
  logger.info("  Scraper completed!");
  printFinalStats(checkpoint.stats);
  logger.info("═══════════════════════════════════════════════\n");

  return checkpoint.stats;
}

/**
 * Helper to process an array of movies in batches.
 */
async function processBatchOfMovies(movies, checkpoint, productionId) {
  // Filter out already-processed
  const pending = movies.filter((m) => !cp.isProcessed(checkpoint, m.id));
  logger.info(`Pending: ${pending.length} (${movies.length - pending.length} already done)`);

  if (pending.length === 0) return;

  // ── Process in batches
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    logger.info(`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pending.length / BATCH_SIZE)} — ${batch.length} movies`);

    const results = await Promise.all(
      batch.map((movie) =>
        limit(() => processMovie(movie, productionId, checkpoint.stats))
      )
    );

    // ── Update checkpoint after each batch
    for (const result of results) {
      if (!result.tmdbId) continue;
      if (result.action === "inserted" || result.action === "updated") {
        cp.markProcessed(checkpoint, result.tmdbId);
      } else if (result.action === "failed") {
        cp.markFailed(checkpoint, result.tmdbId);
      } else if (result.action === "skipped") {
        cp.markSkipped(checkpoint, result.tmdbId);
      }
    }

    cp.save(checkpoint);
    printProgress(checkpoint);

    // Polite pause between batches
    await sleep(500);
  }
}

/**
 * Re-run pipeline only for previously failed TMDB IDs.
 */
async function retryFailedMovies(checkpoint, productionId) {
  const failedIds = [...checkpoint.failedIds];
  if (failedIds.length === 0) {
    logger.info("No failed movies to retry.");
    return;
  }
  logger.info(`Retrying ${failedIds.length} failed movies…`);

  for (const tmdbId of failedIds) {
    const result = await processMovie({ id: tmdbId }, productionId, checkpoint.stats)
      .catch((err) => ({ action: "failed", reason: err.message, tmdbId }));

    if (result.action !== "failed") {
      cp.markProcessed(checkpoint, tmdbId);
    }
    cp.save(checkpoint);
    await sleep(300);
  }
}

/**
 * Run incremental update — only recent movies (last 6 months).
 * Called by the nightly cron job.
 */
async function runIncremental() {
  return run({ recent: true });
}

function printProgress(cp_) {
  const s = cp_.stats;
  logger.info(`Progress — inserted:${s.inserted} updated:${s.updated} skipped:${s.skipped} failed:${s.failed} | cast created:${s.castCreated} reused:${s.castReused}`);
}

function printFinalStats(stats) {
  logger.info(`  Inserted:     ${stats.inserted}`);
  logger.info(`  Updated:      ${stats.updated}`);
  logger.info(`  Skipped:      ${stats.skipped}`);
  logger.info(`  Failed:       ${stats.failed}`);
  logger.info(`  Cast created: ${stats.castCreated}`);
  logger.info(`  Cast reused:  ${stats.castReused}`);
}

module.exports = { run, runIncremental };
