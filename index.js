// ─────────────────────────────────────────────────────────────────────────────
//  index.js — Bollywood Scraper entry point
//
//  Usage:
//    node index.js                          Full run (2015 → present)
//    node index.js --incremental            Only current + last year
//    node index.js --year=2023              Single year
//    node index.js --from=2020 --to=2022    Year range
//    node index.js --reset                  Wipe checkpoint, start fresh
//    node index.js --retry-failed           Retry only previously failed movies
//    node index.js --cron                   Start scheduler (runs nightly)
//    node index.js --validate               Validate existing DB records
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const cron = require("node-cron");
const { run, runIncremental } = require("./src/orchestrator");
const logger = require("./src/utils/logger");

// ── Parse CLI args
const args = process.argv.slice(2);
const argMap = {};
for (const a of args) {
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    argMap[k] = v !== undefined ? v : true;
  }
}

async function main() {
  // Validate required env vars
  if (!process.env.MONGO_URI) {
    logger.error("MONGO_URI is required. Set it in .env");
    process.exit(1);
  }
  if (!process.env.TMDB_API_KEY) {
    logger.warn("TMDB_API_KEY not set — TMDB scraper disabled. Get one free at themoviedb.org");
  }
  if (!process.env.OMDB_API_KEY) {
    logger.warn("OMDB_API_KEY not set — OMDb (IMDb ratings) enrichment disabled. Get one free at omdbapi.com");
  }

  // ── Cron mode: stay alive, run nightly at 3 AM IST
  if (argMap["cron"]) {
    logger.info("Starting cron scheduler — incremental update runs nightly at 03:00 IST");
    await mongoose.connect(process.env.MONGO_URI);
    cron.schedule("0 3 * * *", async () => {
      logger.info("Cron: starting incremental Bollywood scrape…");
      try {
        await runIncremental();
      } catch (err) {
        logger.error("Cron run failed", { err: err.message });
      }
    }, {
      timezone: "Asia/Kolkata"
    });
    logger.info("Cron scheduler active. Press Ctrl+C to stop.");
    return; // keep process alive
  }

  // ── Validate mode: scan DB for issues
  if (argMap["validate"]) {
    await validateDatabase();
    process.exit(0);
  }

  // ── One-shot scrape modes
  const opts = {};

  if (argMap["incremental"]) {
    logger.info("Mode: incremental (last 6 months)");
    await runIncremental();
  } else if (argMap["year"]) {
    const y = parseInt(argMap["year"]);
    logger.info(`Mode: single year ${y}`);
    await run({ startYear: y, endYear: y, ...opts });
  } else if (argMap["from"] || argMap["to"]) {
    const from = parseInt(argMap["from"]) || 2015;
    const to = parseInt(argMap["to"]) || new Date().getFullYear();
    logger.info(`Mode: year range ${from}–${to}`);
    await run({ startYear: from, endYear: to, ...opts });
  } else if (argMap["reset"]) {
    logger.info("Mode: full reset + full run");
    await run({ reset: true });
  } else if (argMap["retry-failed"]) {
    logger.info("Mode: retry failed movies");
    await run({ retryFailed: true });
  } else {
    logger.info("Mode: full run (2015 → present)");
    await run();
  }

  await mongoose.disconnect();
  process.exit(0);
}

/**
 * Validate existing Bollywood movies in DB — flag issues.
 */
async function validateDatabase() {
  await mongoose.connect(process.env.MONGO_URI);
  const Movie = require("./src/enrichers/movieWriter").findExistingMovie
    ? mongoose.model("Movie")
    : null;

  if (!Movie) {
    logger.error("Could not load Movie model");
    return;
  }

  const movies = await Movie.find({ language: "Hindi" }).lean();
  logger.info(`Validating ${movies.length} Hindi movies…`);

  const issues = [];
  for (const m of movies) {
    const problems = [];
    if (!m.posterUrl) problems.push("no poster");
    if (!m.synopsis || m.synopsis.length < 20) problems.push("no synopsis");
    if (!m.director) problems.push("no director");
    if (!m.releaseDate) problems.push("no release date");
    if (!m.genre?.length) problems.push("no genres");
    if (!m.cast?.length) problems.push("no cast");

    if (problems.length > 0) {
      issues.push({ title: m.title, id: m._id, problems });
    }
  }

  if (issues.length === 0) {
    logger.info("✅ All movies pass validation");
  } else {
    logger.warn(`⚠ Found ${issues.length} movies with issues:`);
    for (const issue of issues.slice(0, 50)) {
      logger.warn(`  "${issue.title}" [${issue.id}]: ${issue.problems.join(", ")}`);
    }
    if (issues.length > 50) logger.warn(`  … and ${issues.length - 50} more`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  logger.error("Fatal scraper error", { err: err.message, stack: err.stack });
  process.exit(1);
});
