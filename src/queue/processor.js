// ─────────────────────────────────────────────────────────────────────────────
//  queue/processor.js — Orchestrates the full pipeline for one movie
//  TMDB details → OMDb → Wikipedia → BollywoodHungama → Sacnilk → YouTube
//  → Merge → Validate → Save
//  Supports optional basicInfo._language to override language (e.g. "Bengali")
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { fetchMovieDetails, mapTmdbMovie } = require("../scrapers/tmdb");
const { fetchBengaliMovieDetails, mapTmdbBengaliMovie } = require("../scrapers/tmdb-bengali");
const { fetchByImdbId, searchByTitle, mapOmdbData } = require("../scrapers/omdb");
const { scrapeMovie: scrapeWikipedia } = require("../scrapers/wikipedia");
const { scrapeBoxOffice: scrapeBH, scrapeDailyBoxOffice: scrapeBHDays } = require("../scrapers/bollywoodhungama");
const { scrapeDailyBoxOffice: scrapeSacnilkDays, scrapeBoxOfficeSummary: scrapeSacnilkSummary } = require("../scrapers/sacnilk");
const { searchTrailer, searchSongs } = require("../scrapers/youtube");
const { mergeMovieData } = require("../enrichers/merger");
const { saveMovie } = require("../enrichers/movieWriter");
const logger = require("../utils/logger");

/**
 * Process a single movie through the full scraping pipeline.
 *
 * @param {object} basicInfo    — { id: tmdbId, title, release_date, ... } from TMDB discover
 *                                  Optionally include _language: "Bengali" for non-Hindi movies.
 * @param {string} productionId — MongoDB ObjectId string for scraper production house
 * @param {object} stats        — shared stats counters
 * @returns {{ action, movieId, tmdbId }}
 */
async function processMovie(basicInfo, productionId, stats) {
  const tmdbId = basicInfo.id;
  const title = basicInfo.title || basicInfo.original_title || "";
  const year = basicInfo.release_date
    ? new Date(basicInfo.release_date).getFullYear()
    : null;
  const isBengali = basicInfo._language === "Bengali";

  logger.info(`Processing: "${title}" (${year}) [TMDB:${tmdbId}]${isBengali ? " [Bengali]" : ""}`);

  try {
    // ── Step 1: TMDB full details (primary source)
    // Use Bengali mapper when _language is "Bengali" so language field is set correctly
    const rawTmdb = isBengali
      ? await fetchBengaliMovieDetails(tmdbId)
      : await fetchMovieDetails(tmdbId);
    const tmdb = rawTmdb
      ? (isBengali ? mapTmdbBengaliMovie(rawTmdb) : mapTmdbMovie(rawTmdb))
      : null;

    if (!tmdb) {
      logger.warn(`TMDB details missing for ${title} — skipping`);
      return { action: "skipped", reason: "no_tmdb", tmdbId };
    }

    // ── Step 2: OMDb (IMDb data, ratings, awards)
    let omdb = null;
    if (tmdb.imdbId) {
      const rawOmdb = await fetchByImdbId(tmdb.imdbId).catch(() => null);
      omdb = rawOmdb ? mapOmdbData(rawOmdb) : null;
    }
    if (!omdb && title && year) {
      const rawOmdb = await searchByTitle(title, year).catch(() => null);
      omdb = rawOmdb ? mapOmdbData(rawOmdb) : null;
    }

    // ── Step 3: Wikipedia
    const wikipedia = await scrapeWikipedia(title, year).catch(() => null);

    // ── Step 4: BollywoodHungama (additional cast + box office)
    const bh = await scrapeBH(title, year).catch(() => null);

    // ── Step 5: Sacnilk day-wise box office
    const sacnilkDays = await scrapeSacnilkDays(title, year).catch(() => []);
    const sacnilkSummary = await scrapeSacnilkSummary(title, year).catch(() => null);

    // ── Step 6: YouTube (trailer fallback if TMDB missing)
    let youtubeData = null;
    if (!tmdb.trailer) {
      const ytTrailer = await searchTrailer(title, year).catch(() => null);
      youtubeData = ytTrailer ? { trailer: ytTrailer } : null;
    }

    // ── Step 7: Merge all sources
    const merged = mergeMovieData({
      tmdb,
      omdb,
      wikipedia,
      bollywoodhungama: bh,
      sacnilk: sacnilkSummary,
      youtube: youtubeData,
    });

    // Attach day-wise box office (Sacnilk preferred, BH fallback)
    const bhDays = bh ? await scrapeBHDays(title, year).catch(() => []) : [];
    const bestDays = sacnilkDays.length >= bhDays.length ? sacnilkDays : bhDays;
    if (bestDays.length > 0) {
      merged.boxOfficeDays = bestDays.map(({ _rawNet, ...d }) => d); // strip internal field
    }

    // ── Step 8: Save to MongoDB
    const result = await saveMovie(merged, productionId, stats);
    return { ...result, tmdbId, title };

  } catch (err) {
    logger.error(`Movie pipeline failed: "${title}" (TMDB:${tmdbId})`, {
      err: err.message,
      stack: err.stack?.split("\n")[1],
    });
    return { action: "failed", reason: err.message, tmdbId, title };
  }
}

module.exports = { processMovie };
