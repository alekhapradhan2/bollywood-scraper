// -----------------------------------------------------------------------------
//  orchestrator-regional.js - Generic movie scraper orchestrator for regions
//  Handles Telugu, Malayalam, Bengali based on REGIONS configuration.
// -----------------------------------------------------------------------------
"use strict";

const pLimit = require("p-limit");
const mongoose = require("mongoose");
const {
  END_YEAR,
  TMDB_CONCURRENCY,
  BATCH_SIZE,
  REGIONS
} = require("./config");
const { fetchAllRegionalMoviesByYear, fetchAllRecentRegionalMovies } = require("./scrapers/tmdb-regional");
const { processMovie } = require("./queue/processor");
const logger = require("./utils/logger");
const { sleep } = require("./utils/http");
const fs = require("fs");
const path = require("path");

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

function getCheckpointPath(regionKey) {
  return path.resolve(__dirname, "../", `./checkpoints/${regionKey}-progress.json`);
}

function loadCheckpoint(regionKey) {
  const cpPath = getCheckpointPath(regionKey);
  try {
    if (fs.existsSync(cpPath)) {
      const raw = fs.readFileSync(cpPath, "utf-8");
      const data = JSON.parse(raw);
      return { ...DEFAULT_CHECKPOINT, ...data, stats: { ...DEFAULT_CHECKPOINT.stats, ...data.stats } };
    }
  } catch (err) {
    logger.warn(`${regionKey} checkpoint load failed - starting fresh.`, { err: err.message });
  }
  return { ...DEFAULT_CHECKPOINT, stats: { ...DEFAULT_CHECKPOINT.stats } };
}

function saveCheckpoint(cp, regionKey) {
  const cpPath = getCheckpointPath(regionKey);
  const cpDir = path.dirname(cpPath);
  if (!fs.existsSync(cpDir)) fs.mkdirSync(cpDir, { recursive: true });

  try {
    cp.lastUpdated = new Date().toISOString();
    fs.writeFileSync(cpPath, JSON.stringify(cp, null, 2), "utf-8");
  } catch (err) {
    logger.error(`${regionKey} checkpoint save failed!`, { err: err.message });
  }
}

function resetCheckpoint(regionKey) {
  const fresh = { ...DEFAULT_CHECKPOINT, stats: { ...DEFAULT_CHECKPOINT.stats }, startedAt: new Date().toISOString() };
  saveCheckpoint(fresh, regionKey);
  return fresh;
}

function isProcessed(cp, tmdbId) {
  return cp.processedIds.includes(tmdbId) || cp.skippedIds.includes(tmdbId);
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

const limit = pLimit(TMDB_CONCURRENCY);

/**
 * Run the regional scraper for a specific year range.
 */
async function runRegional(regionKey, opts = {}) {
  const config = REGIONS[regionKey];
  if (!config) {
    logger.error(`Invalid region key: ${regionKey}`);
    return;
  }

  const { langName, tmdbLang, startYear: defaultStartYear } = config;
  const startYear = opts.startYear || defaultStartYear;
  const endYear = opts.endYear || END_YEAR;
  const doReset = opts.reset || false;
  const retryFailed = opts.retryFailed || false;
  const doRecent = opts.recent || false;

  logger.info("=================================================");
  logger.info(`  ${langName} Movie Scraper - ${startYear} to ${endYear}`);
  logger.info("=================================================");

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGO_URI);
    logger.info(`MongoDB connected (${langName} scraper)`);
  }

  // No production house attached for regional movies as requested
  const productionId = null;

  let checkpoint = doReset ? resetCheckpoint(regionKey) : loadCheckpoint(regionKey);
  if (!checkpoint.startedAt) {
    checkpoint.startedAt = new Date().toISOString();
    saveCheckpoint(checkpoint, regionKey);
  }

  logger.info(`${langName} checkpoint loaded`, {
    processed: checkpoint.processedIds.length,
    failed: checkpoint.failedIds.length,
    skipped: checkpoint.skippedIds.length,
  });

  if (retryFailed) {
    await retryFailedRegionalMovies(regionKey, config, checkpoint, productionId);
    return checkpoint.stats;
  }

  if (doRecent) {
    logger.info(`\n---- Mode: Recent ${langName} (Last 6 Months) ----`);
    const movies = await fetchAllRecentRegionalMovies(tmdbLang);
    logger.info(`Found ${movies.length} recent ${langName} movies`);
    checkpoint.totalMovies += movies.length;
    saveCheckpoint(checkpoint, regionKey);
    await processRegionalBatch(regionKey, config, movies, checkpoint, productionId);
  } else {
    for (let year = startYear; year <= endYear; year++) {
      logger.info(`\n---- ${langName} Year: ${year} ----`);
      checkpoint.currentYear = year;
      saveCheckpoint(checkpoint, regionKey);

      const movies = await fetchAllRegionalMoviesByYear(year, tmdbLang);
      logger.info(`Found ${movies.length} ${langName} movies for ${year}`);
      checkpoint.totalMovies += movies.length;
      saveCheckpoint(checkpoint, regionKey);

      await processRegionalBatch(regionKey, config, movies, checkpoint, productionId);
    }
  }

  logger.info("\n=================================================");
  logger.info(`  ${langName} Scraper completed!`);
  printProgress(checkpoint, langName);
  logger.info("=================================================\n");

  return checkpoint.stats;
}

async function processRegionalBatch(regionKey, config, movies, checkpoint, productionId) {
  const pending = movies.filter((m) => !isProcessed(checkpoint, m.id));
  logger.info(`${config.langName} pending: ${pending.length} (${movies.length - pending.length} already done)`);

  if (pending.length === 0) return;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    logger.info(`${config.langName} batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pending.length / BATCH_SIZE)} - ${batch.length} movies`);

    const results = await Promise.all(
      batch.map((movie) =>
        limit(() => processMovie({ ...movie, _language: config.langName, _regionKey: regionKey }, productionId, checkpoint.stats))
      )
    );

    for (const result of results) {
      if (!result.tmdbId) continue;
      if (result.action === "inserted" || result.action === "updated") {
        markProcessed(checkpoint, result.tmdbId);
      } else if (result.action === "failed") {
        markFailed(checkpoint, result.tmdbId);
      } else if (result.action === "skipped") {
        markSkipped(checkpoint, result.tmdbId);
      }
    }

    saveCheckpoint(checkpoint, regionKey);
    printProgress(checkpoint, config.langName);
    await sleep(500);
  }
}

async function retryFailedRegionalMovies(regionKey, config, checkpoint, productionId) {
  const failedIds = [...checkpoint.failedIds];
  if (failedIds.length === 0) {
    logger.info(`No failed ${config.langName} movies to retry.`);
    return;
  }
  logger.info(`Retrying ${failedIds.length} failed ${config.langName} movies...`);

  for (const tmdbId of failedIds) {
    const result = await processMovie({ id: tmdbId, _language: config.langName, _regionKey: regionKey }, productionId, checkpoint.stats)
      .catch((err) => ({ action: "failed", reason: err.message, tmdbId }));

    if (result.action !== "failed") {
      markProcessed(checkpoint, tmdbId);
    }
    saveCheckpoint(checkpoint, regionKey);
    await sleep(300);
  }
}

async function runRegionalIncremental(regionKey) {
  return runRegional(regionKey, { recent: true });
}

function printProgress(cp_, langName) {
  const s = cp_.stats;
  logger.info(`${langName} stats - inserted:${s.inserted} updated:${s.updated} skipped:${s.skipped} failed:${s.failed} | cast created:${s.castCreated} reused:${s.castReused}`);
}

module.exports = { runRegional, runRegionalIncremental };
