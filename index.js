// ─────────────────────────────────────────────────────────────────────────────
//  index.js — Bollywood + Bengali Scraper entry point
//
//  Bollywood (Hindi) Usage:
//    node index.js                          Full run (2015 → present)
//    node index.js --incremental            Only current + last year
//    node index.js --year=2023              Single year
//    node index.js --from=2020 --to=2022    Year range
//    node index.js --reset                  Wipe checkpoint, start fresh
//    node index.js --retry-failed           Retry only previously failed movies
//    node index.js --release-upcoming       Auto-update past 'Upcoming' movies to 'Released'
//    node index.js --cron                   Start scheduler (runs nightly)
//    node index.js --validate               Validate existing DB records
//
//  Bengali Usage:
//    node index.js --bengali                Full Bengali run (2000 → present)
//    node index.js --bengali --incremental  Bengali incremental (last 6 months)
//    node index.js --bengali --year=2010    Bengali single year
//    node index.js --bengali --from=2005 --to=2015  Bengali year range
//    node index.js --bengali --reset        Bengali reset + full run
//    node index.js --bengali --retry-failed Bengali retry failed
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const cron = require("node-cron");
const http = require("http");
const https = require("https");
const { run, runIncremental } = require("./src/orchestrator");
const { runBengali, runBengaliIncremental } = require("./src/orchestrator-bengali");
const logger = require("./src/utils/logger");

async function autoReleaseUpcomingMovies() {
  logger.info("Running auto-release check for upcoming movies...");
  const Movie = mongoose.models.Movie || mongoose.model("Movie", new mongoose.Schema({}, { strict: false }));
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split("T")[0];

  const query = {
    status: "Upcoming",
    releaseDate: { $lte: todayStr, $ne: "", $ne: "TBA", $ne: null }
  };

  try {
    const moviesToUpdate = await Movie.find(query);
    let updatedCount = 0;
    for (const m of moviesToUpdate) {
      await Movie.findByIdAndUpdate(m._id, {
        $set: { status: "Released", verdict: "Released" }
      });
      logger.info(`Auto-released: "${m.title}" (Date: ${m.releaseDate})`);
      updatedCount++;
    }
    logger.info(`Auto-release check complete. Updated ${updatedCount} movies.`);
  } catch (err) {
    logger.error("Auto-release check failed", { err: err.message });
  }
}

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

  // ── Auto-release manual mode
  if (argMap["release-upcoming"]) {
    await mongoose.connect(process.env.MONGO_URI);
    await autoReleaseUpcomingMovies();
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── Cron mode: stay alive, run nightly at 3 AM IST
  if (argMap["cron"]) {
    logger.info("Starting cron scheduler — incremental update runs nightly at 03:00 IST");
    await mongoose.connect(process.env.MONGO_URI);
    
    // Set up keep-alive HTTP server
    const PORT = process.env.PORT || 3000;
    const server = http.createServer((req, res) => {
      if (req.url === "/ping") {
        res.writeHead(200);
        res.end("pong");
      } else {
        res.writeHead(200);
        res.end("Bollywood Scraper Cron is running!");
      }
    });

    server.listen(PORT, () => {
      logger.info(`Keep-alive server listening on port ${PORT}`);
      
      // Ping itself every 2 minutes (120000 ms) to prevent sleeping on free tiers
      setInterval(() => {
        const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}/ping`;
        const protocol = url.startsWith("https") ? https : http;
        protocol.get(url, (res) => {
          logger.info(`Self-ping successful: ${res.statusCode}`);
        }).on("error", (err) => {
          logger.warn(`Self-ping failed: ${err.message}`);
        });
      }, 2 * 60 * 1000);
    });

    cron.schedule("50 2 * * *", async () => {
      logger.info("Cron: starting auto-release upcoming movies check…");
      await autoReleaseUpcomingMovies();
    }, {
      timezone: "Asia/Kolkata"
    });

    cron.schedule("0 3 * * *", async () => {
      logger.info("Cron: starting incremental Bollywood scrape…");
      try {
        await runIncremental();
      } catch (err) {
        logger.error("Bollywood Cron run failed", { err: err.message });
      }
    }, {
      timezone: "Asia/Kolkata"
    });

    cron.schedule("0 4 * * *", async () => {
      logger.info("Cron: starting incremental OTT scrape (last 6 months)…");
      try {
        const { runOttIncremental } = require("./ott-scraper");
        await runOttIncremental();
      } catch (err) {
        logger.error("OTT Cron run failed", { err: err.message });
      }
    }, {
      timezone: "Asia/Kolkata"
    });

    cron.schedule("0 5 * * *", async () => {
      logger.info("Cron: starting incremental Bengali scrape…");
      try {
        await runBengaliIncremental();
      } catch (err) {
        logger.error("Bengali Cron run failed", { err: err.message });
      }
    }, {
      timezone: "Asia/Kolkata"
    });

    logger.info("Cron scheduler active: Auto-Release@02:50 | Bollywood@03:00 | OTT@04:00 | Bengali@05:00");
    return; // keep process alive
  }

  // ── Validate mode: scan DB for issues
  if (argMap["validate"]) {
    await validateDatabase();
    process.exit(0);
  }

  // ── Bengali scrape modes
  if (argMap["bengali"]) {
    if (!process.env.MONGO_URI) {
      logger.error("MONGO_URI is required.");
      process.exit(1);
    }
    if (argMap["incremental"]) {
      logger.info("Bengali mode: incremental (last 6 months)");
      await runBengaliIncremental();
    } else if (argMap["year"]) {
      const y = parseInt(argMap["year"]);
      logger.info(`Bengali mode: single year ${y}`);
      await runBengali({ startYear: y, endYear: y });
    } else if (argMap["from"] || argMap["to"]) {
      const from = parseInt(argMap["from"]) || 2000;
      const to = parseInt(argMap["to"]) || new Date().getFullYear();
      logger.info(`Bengali mode: year range ${from}–${to}`);
      await runBengali({ startYear: from, endYear: to });
    } else if (argMap["reset"]) {
      logger.info("Bengali mode: full reset + full run");
      await runBengali({ reset: true });
    } else if (argMap["retry-failed"]) {
      logger.info("Bengali mode: retry failed movies");
      await runBengali({ retryFailed: true });
    } else {
      logger.info("Bengali mode: full run (2000 → present)");
      await runBengali();
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── Bollywood one-shot scrape modes
  const opts = {};

  if (argMap["tmdb"]) {
    const ids = argMap["tmdb"].split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    logger.info(`Mode: specific TMDB IDs: ${ids.join(", ")}`);
    await run({ tmdbIds: ids, ...opts });
  } else if (argMap["search"]) {
    const query = argMap["search"];
    const tmdbScraper = require("./src/scrapers/tmdb");
    logger.info(`Searching TMDB for: "${query}"`);
    const results = await tmdbScraper.searchMovie(query);
    if (results.length > 0) {
      logger.info(`Found ${results.length} results. Taking the first one: "${results[0].title}" (${results[0].release_date}) - ID: ${results[0].id}`);
      await run({ tmdbIds: [results[0].id], ...opts });
    } else {
      logger.error(`No results found for "${query}"`);
    }
  } else if (argMap["incremental"]) {
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
