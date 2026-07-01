#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  ott-scraper.js
//  Fills streamingOn, streamingUrl, and ottReleaseDate for every movie in DB
//
//  Data source: TMDB Watch Providers API (free, accurate, India-specific)
//  Endpoint: GET /movie/{tmdb_id}/watch/providers
//
//  Usage:
//    node ott-scraper.js                      # fill all movies (missing OTT)
//    node ott-scraper.js --all                # re-fetch even already filled
//    node ott-scraper.js --year=2023          # only movies released in 2023
//    node ott-scraper.js --from=2020 --to=2023  # year range 2020–2023
//    node ott-scraper.js --id=<mongoId>       # single movie by MongoDB _id
//    node ott-scraper.js --bengali            # only process Bengali movies
//    node ott-scraper.js --dry-run            # preview, no DB writes
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

require("dotenv").config();
const axios     = require("axios");
const mongoose  = require("mongoose");
const cron      = require("node-cron");
const http      = require("http");
const https     = require("https");

// ── Config ────────────────────────────────────────────────────────────────────
const MONGO_URI    = process.env.MONGO_URI;
const TMDB_KEY     = process.env.TMDB_API_KEY;
const TMDB_BASE    = "https://api.themoviedb.org/3";
const COUNTRY      = "IN";          // India OTT market
const CONCURRENCY  = 4;             // parallel TMDB calls
const DELAY_MS     = 300;           // polite delay between requests
const DRY_RUN    = process.argv.includes("--dry-run");
const REFETCH_ALL= process.argv.includes("--all");
const SINGLE_ID  = (process.argv.find(a => a.startsWith("--id="))   || "").replace("--id=",   "");
const YEAR_ARG   = (process.argv.find(a => a.startsWith("--year=")) || "").replace("--year=", "");
const FROM_ARG   = (process.argv.find(a => a.startsWith("--from=")) || "").replace("--from=", "");
const TO_ARG     = (process.argv.find(a => a.startsWith("--to="))   || "").replace("--to=",   "");
const BENGALI_ARG= process.argv.includes("--bengali");
const CRON_MODE  = process.argv.includes("--cron");
const CUR_YEAR   = new Date().getFullYear();

// ── OTT Platform metadata (TMDB provider_id → name + direct URL) ─────────────
// IDs confirmed from live TMDB scan of the actual database (India market)
const PROVIDER_MAP = {
  // ── Subscription platforms (flatrate) ─────────────────────────────────────
  8:    { name: "Netflix",            url: "https://www.netflix.com/in" },
  119:  { name: "Amazon Prime Video", url: "https://www.primevideo.com" },
  2100: { name: "Amazon Prime Video", url: "https://www.primevideo.com" }, // Prime with Ads
  1898: { name: "Amazon MX Player",   url: "https://www.mxplayer.in" },
  2336: { name: "JioHotstar",         url: "https://www.jiohotstar.com" }, // merged JioCinema + Hotstar
  232:  { name: "ZEE5",               url: "https://www.zee5.com" },
  237:  { name: "SonyLIV",            url: "https://www.sonyliv.com" },
  515:  { name: "MX Player",          url: "https://www.mxplayer.in" },
  437:  { name: "Hungama Play",        url: "https://www.hungama.com" },
  474:  { name: "ShemarooMe",          url: "https://www.shemaroo.com" },
  538:  { name: "Plex",               url: "https://www.plex.tv" },
  614:  { name: "VI Movies & TV",      url: "https://www.myvi.in/entertainment" },
  2736: { name: "Brew",               url: "https://www.brew.com" },

  // ── Eros Now variants ─────────────────────────────────────────────────────
  218:  { name: "Eros Now",           url: "https://erosnow.com" },
  457:  { name: "Eros Now",           url: "https://erosnow.com" },
  2059: { name: "Eros Now",           url: "https://erosnow.com" }, // "Eros Now Select Apple TV Channel"

  // ── Rent / Buy stores (kept for reference but low priority) ───────────────
  2:   { name: "Apple TV",            url: "https://tv.apple.com" },
  3:   { name: "Google Play Movies",  url: "https://play.google.com/store/movies" },
  192: { name: "YouTube",             url: "https://www.youtube.com" },

  // ── Additional platforms (may appear in future scans) ─────────────────────
  11:  { name: "MUBI",               url: "https://mubi.com" },
  121: { name: "Voot",               url: "https://www.voot.com" },
  122: { name: "JioHotstar",          url: "https://www.jiohotstar.com" }, // old Disney+ Hotstar ID
  220: { name: "JioHotstar",          url: "https://www.jiohotstar.com" }, // old JioCinema ID
  305: { name: "Hungama Play",        url: "https://www.hungama.com" },
  309: { name: "Sun NXT",             url: "https://www.sunnxt.com" },
  315: { name: "Hoichoi",             url: "https://www.hoichoi.tv" },
  350: { name: "Apple TV+",           url: "https://tv.apple.com" },
  387: { name: "Lionsgate Play",      url: "https://www.lionsgateplay.com" },
  573: { name: "ALTBalaji",           url: "https://www.altbalaji.com" },
  619: { name: "Airtel Xstream",      url: "https://www.airtelxstream.in" },
  625: { name: "ShemarooMe",          url: "https://www.shemaroo.com" },
};

// Priority order — prefer subscription (flatrate) over rent/buy
const PROVIDER_PRIORITY = ["flatrate", "subscription", "free", "ads", "rent", "buy"];

// ── Mongoose Movie model (minimal — only what we need) ────────────────────────
const MovieSchema = new mongoose.Schema(
  {
    title:          String,
    imdbId:         String,
    streamingOn:    { type: String, default: "" },
    streamingUrl:   { type: String, default: "" },
    ottReleaseDate: { type: String, default: "" },
  },
  { strict: false, collection: "movies" }
);
const Movie = mongoose.models.Movie || mongoose.model("Movie", MovieSchema);

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

let reqCount = 0;
async function tmdbGet(path, params = {}) {
  reqCount++;
  const url = `${TMDB_BASE}${path}`;
  const res = await axios.get(url, {
    params: { api_key: TMDB_KEY, ...params },
    timeout: 15000,
  });
  return res.data;
}

/** Resolve TMDB movie ID from imdbId or by title search */
async function resolveTmdbId(movie) {
  // Try IMDb ID lookup first (most accurate)
  if (movie.imdbId && /^tt\d+$/.test(movie.imdbId)) {
    try {
      const data = await tmdbGet("/find/" + movie.imdbId, {
        external_source: "imdb_id",
      });
      const result = data.movie_results?.[0];
      if (result?.id) return result.id;
    } catch (_) {}
  }
  return null;
}

/** Get streaming info for a TMDB movie ID (India market) */
async function getOttData(tmdbId) {
  try {
    const data = await tmdbGet(`/movie/${tmdbId}/watch/providers`);
    const india = data.results?.[COUNTRY];
    if (!india) return null;

    // Try each priority tier to find the best provider
    for (const tier of PROVIDER_PRIORITY) {
      const providers = india[tier];
      if (!providers || providers.length === 0) continue;

      // Sort by known provider priority (prefer popular platforms)
      const knownProviders = providers.filter(p => PROVIDER_MAP[p.provider_id]);
      const chosen = knownProviders[0] || providers[0];
      if (!chosen) continue;

      const meta = PROVIDER_MAP[chosen.provider_id];
      return {
        streamingOn:  meta?.name  || chosen.provider_name,
        // Use direct platform URL; fall back to TMDB watch page only for unknown providers
        streamingUrl: meta?.url   || india.link || "",
      };
    }
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error(`  ⚠ TMDB watch/providers error for tmdbId ${tmdbId}:`, err.message);
    }
  }
  return null;
}

/** Get OTT release date from TMDB release dates endpoint */
async function getOttReleaseDate(tmdbId) {
  try {
    const data = await tmdbGet(`/movie/${tmdbId}/release_dates`);
    const india = data.results?.find(r => r.iso_3166_1 === COUNTRY);

    if (india) {
      // type 4 = Digital (OTT), type 5 = Physical, type 6 = TV
      const digital = india.release_dates?.find(rd => rd.type === 4);
      if (digital?.release_date) {
        return digital.release_date.split("T")[0];   // YYYY-MM-DD
      }
    }

    // Fallback: check US release dates for digital
    const us = data.results?.find(r => r.iso_3166_1 === "US");
    if (us) {
      const digital = us.release_dates?.find(rd => rd.type === 4);
      if (digital?.release_date) {
        return digital.release_date.split("T")[0];
      }
    }
  } catch (_) {}
  return "";
}

// ── Progress tracker ──────────────────────────────────────────────────────────
let processed = 0, updated = 0, skipped = 0, failed = 0;

function printProgress(total) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  process.stdout.write(
    `\r  Progress: ${processed}/${total} (${pct}%) | ✅ Updated: ${updated} | ⏭ Skipped: ${skipped} | ❌ Failed: ${failed}   `
  );
}

// ── Core processor ────────────────────────────────────────────────────────────
async function processMovie(movie, total) {
  try {
    // Resolve TMDB ID
    const tmdbId = await resolveTmdbId(movie);
    await sleep(DELAY_MS);

    if (!tmdbId) {
      console.log(`\n  ⚠ [${movie.title}] Could not resolve TMDB ID (imdbId: ${movie.imdbId || "none"})`);
      skipped++;
      processed++;
      printProgress(total);
      return;
    }

    // Fetch watch providers + OTT release date in parallel
    const [ottData, ottDate] = await Promise.all([
      getOttData(tmdbId),
      getOttReleaseDate(tmdbId),
    ]);
    await sleep(DELAY_MS);

    if (!ottData && !ottDate) {
      console.log(`\n  ℹ [${movie.title}] Not available on OTT in India yet`);
      skipped++;
      processed++;
      printProgress(total);
      return;
    }

    const update = {
      streamingOn:    ottData?.streamingOn    || "",
      streamingUrl:   ottData?.streamingUrl   || "",
      ottReleaseDate: ottDate                 || "",
    };

    if (DRY_RUN) {
      console.log(`\n  [DRY-RUN] ${movie.title} →`, update);
    } else {
      await Movie.findByIdAndUpdate(movie._id, { $set: update });
    }

    console.log(`\n  ✅ [${movie.title}] → ${update.streamingOn || "OTT release: " + update.ottReleaseDate}`);
    updated++;
  } catch (err) {
    console.error(`\n  ❌ [${movie.title}] Error:`, err.message);
    failed++;
  }

  processed++;
  printProgress(total);
}

// ── Build MongoDB query with optional year filter ─────────────────────────────
function buildQuery(yearFilter) {
  const conditions = [];

  // Year filter: releaseDate is stored as "YYYY-MM-DD" string
  if (yearFilter) {
    conditions.push({ releaseDate: { $regex: `^${yearFilter}` } });
  }

  // Language filter
  if (BENGALI_ARG) {
    conditions.push({ language: "Bengali" });
  }

  // Missing OTT filter (skip when --all or single ID)
  if (!REFETCH_ALL && !SINGLE_ID) {
    conditions.push({
      $or: [
        { streamingOn:    { $in: ["", null] } },
        { streamingOn:    { $exists: false   } },
        { ottReleaseDate: { $in: ["", null] } },
        { ottReleaseDate: { $exists: false   } },
      ],
    });
  }

  return conditions.length > 1 ? { $and: conditions }
       : conditions.length === 1 ? conditions[0]
       : {};
}

// ── Process one year batch ────────────────────────────────────────────────────
async function processYear(year, pLimit) {
  // Reset counters per year
  processed = 0; updated = 0; skipped = 0; failed = 0;

  const query  = buildQuery(year);
  const movies = await Movie.find(
    query,
    "title imdbId releaseDate streamingOn streamingUrl ottReleaseDate"
  ).lean();
  const total = movies.length;

  if (total === 0) {
    console.log(`  ✨ No movies to process for ${year}`);
    return { updated: 0, skipped: 0, failed: 0 };
  }

  console.log(`  📋 ${total} movie(s) found for ${year}`);

  const limit = pLimit(CONCURRENCY);
  await Promise.all(movies.map(m => limit(() => processMovie(m, total))));

  return { updated, skipped, failed };
}

async function executeScrape(startYear, endYear, pLimit) {
  if (SINGLE_ID) {
    console.log(`🎯 Single movie: ${SINGLE_ID}`);
    const movie = await Movie.findById(
      new mongoose.Types.ObjectId(SINGLE_ID),
      "title imdbId releaseDate streamingOn streamingUrl ottReleaseDate"
    ).lean();
    if (!movie) {
      console.error("❌ Movie not found");
      return;
    }
    const total = 1;
    await processMovie(movie, total);
    printProgress(total);
  } else {
    const years = [];
    for (let y = startYear; y <= endYear; y++) years.push(y);

    const grandTotal = { updated: 0, skipped: 0, failed: 0 };

    for (const year of years) {
      console.log(`\n${'▓'.repeat(52)}`);
      console.log(`  📅  ${year}`);
      console.log(`${'▓'.repeat(52)}`);

      const result = await processYear(String(year), () => pLimit(CONCURRENCY));
      grandTotal.updated  += result.updated;
      grandTotal.skipped  += result.skipped;
      grandTotal.failed   += result.failed;

      if (year < endYear) await sleep(500);
    }

    console.log("\n\n" + "═".repeat(52));
    console.log("📊 GRAND SUMMARY  (" + startYear + " → " + endYear + ")");
    console.log("═".repeat(52));
    console.log(`  ✅ Updated       : ${grandTotal.updated}`);
    console.log(`  ⏭  Skipped       : ${grandTotal.skipped}`);
    console.log(`  ❌ Failed        : ${grandTotal.failed}`);
    console.log(`  🌐 TMDB requests : ${reqCount}`);
    console.log("═".repeat(52));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!MONGO_URI) { console.error("❌ MONGO_URI not set in .env"); process.exit(1); }
  if (!TMDB_KEY)  { console.error("❌ TMDB_API_KEY not set in .env"); process.exit(1); }

  // Determine year range
  let startYear, endYear;
  if (SINGLE_ID) {
    startYear = endYear = null;
  } else if (YEAR_ARG) {
    startYear = endYear = parseInt(YEAR_ARG);
  } else if (FROM_ARG || TO_ARG) {
    startYear = parseInt(FROM_ARG) || 2000;
    endYear   = parseInt(TO_ARG)   || CUR_YEAR;
  } else {
    startYear = 2000;
    endYear   = CUR_YEAR;
  }

  console.log("🎬 OTT Scraper — The Cinema Verse");
  console.log("━".repeat(52));
  console.log(`  Mode     : ${DRY_RUN ? "DRY RUN (no writes)" : (CRON_MODE ? "CRON SCHEDULER" : "LIVE")}`);
  console.log(`  Refetch  : ${REFETCH_ALL ? "ALL movies" : "only missing OTT data"}`);
  if (SINGLE_ID)   console.log(`  Target   : single movie ${SINGLE_ID}`);
  else             console.log(`  Years    : ${startYear} → ${endYear}`);
  console.log(`  Language : ${BENGALI_ARG ? "Bengali" : "All"}`);
  console.log(`  Market   : India (IN)`);
  console.log("━".repeat(52));

  console.log("\n📡 Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI, { dbName: "test" });
  console.log("✅ Connected\n");

  const { default: pLimit } = await import("p-limit");

  // Normal run
  await executeScrape(startYear, endYear, pLimit);

  await mongoose.disconnect();
  console.log("\n✅ Done!\n");
}

// ── Exported Incremental Mode for index.js Cron ──────────────────────────────
async function runOttIncremental() {
  console.log("\n🎬 OTT Scraper — Running 6-month incremental update");
  
  if (!MONGO_URI || !TMDB_KEY) {
    console.warn("⚠ Missing MONGO_URI or TMDB_API_KEY. Skipping OTT update.");
    return;
  }
  
  // Calculate date 6 months ago
  const date = new Date();
  date.setMonth(date.getMonth() - 6);
  const sixMonthsAgoStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
  
  const query = {
    releaseDate: { $gte: sixMonthsAgoStr },
    $or: [
      { streamingOn:    { $in: ["", null] } },
      { streamingOn:    { $exists: false   } },
      { ottReleaseDate: { $in: ["", null] } },
      { ottReleaseDate: { $exists: false   } },
    ],
  };

  const movies = await Movie.find(
    query,
    "title imdbId releaseDate streamingOn streamingUrl ottReleaseDate"
  ).lean();
  
  const total = movies.length;
  if (total === 0) {
    console.log(`✨ No movies missing OTT data in the last 6 months (since ${sixMonthsAgoStr}).`);
    return;
  }
  
  console.log(`📋 Found ${total} movie(s) missing OTT data since ${sixMonthsAgoStr}`);
  
  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(CONCURRENCY);
  
  processed = 0; updated = 0; skipped = 0; failed = 0;
  await Promise.all(movies.map(m => limit(() => processMovie(m, total))));
  
  console.log(`\n✅ OTT Incremental done. Updated: ${updated}, Skipped: ${skipped}, Failed: ${failed}\n`);
}

module.exports = { runOttIncremental };

// ── Standalone CLI Execution ──────────────────────────────────────────────────
if (require.main === module) {
  main().catch(err => {
    console.error("\n❌ Fatal error:", err);
    process.exit(1);
  });
}
