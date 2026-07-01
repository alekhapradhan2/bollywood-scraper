// ─────────────────────────────────────────────────────────────────────────────
//  config.js — Central configuration for Bollywood + Bengali scraper
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

module.exports = {
  // ── Date range — Bollywood
  START_YEAR: 2015,
  END_YEAR: new Date().getFullYear() + 2,

  // ── Date range — Bengali (wider history)
  BENGALI_START_YEAR: 2000,

  // ── Source APIs
  TMDB_API_KEY: process.env.TMDB_API_KEY || "",          // https://www.themoviedb.org/settings/api
  OMDB_API_KEY: process.env.OMDB_API_KEY || "",          // https://www.omdbapi.com/apikey.aspx
  TMDB_BASE: "https://api.themoviedb.org/3",
  OMDB_BASE: "https://www.omdbapi.com",
  TMDB_IMG_BASE: "https://image.tmdb.org/t/p",

  // ── Rate limiting
  TMDB_CONCURRENCY: 4,          // parallel TMDB calls
  SCRAPE_CONCURRENCY: 2,        // parallel scrape calls (be polite)
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 2000,
  REQUEST_TIMEOUT_MS: 30000,

  // ── Queue
  BATCH_SIZE: 20,               // movies per batch before checkpoint

  // ── Confidence thresholds
  MIN_CONFIDENCE: 0.4,          // below this, skip field
  FIELD_WEIGHTS: {
    tmdb:       1.0,
    omdb:       0.9,
    wikipedia:  0.85,
    imdb:       0.95,
    bollywood_hungama: 0.7,
    filmibeat:  0.65,
    sacnilk:    0.75,
  },

  // ── Languages considered Bollywood (Hindi-primary)
  BOLLYWOOD_LANGUAGES: ["hi", "Hindi"],

  // ── Languages considered Bengali
  BENGALI_LANGUAGES: ["bn", "Bengali"],

  // ── Default production house ID for scraped movies (Bollywood)
  SCRAPER_PRODUCTION_ID: process.env.SCRAPER_PRODUCTION_ID || "",

  // ── Production house ID for Bengali scraper (optional — falls back to SCRAPER_PRODUCTION_ID)
  BENGALI_SCRAPER_PRODUCTION_ID: process.env.BENGALI_SCRAPER_PRODUCTION_ID || "",

  // ── Checkpoint / log paths (relative to scraper root)
  CHECKPOINT_FILE: "./checkpoints/progress.json",
  BENGALI_CHECKPOINT_FILE: "./checkpoints/bengali-progress.json",
  LOG_DIR: "./logs",

  // ── Image poster sizes
  POSTER_SIZE: "w500",
  BACKDROP_SIZE: "w1280",
  PROFILE_SIZE: "w185",

  // ── Delay between requests to same domain (ms)
  POLITE_DELAY_MS: 800,
};
