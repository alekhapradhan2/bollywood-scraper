// ─────────────────────────────────────────────────────────────────────────────
//  enrichers/movieWriter.js — Save/update a merged movie into MongoDB
//  Handles deduplication, partial updates, and cast linking.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const { makeSlug, validateUrl } = require("../utils/normalizer");
const { resolveCastAndCrew, linkMovieToCast } = require("./castResolver");
const logger = require("../utils/logger");

// ── Reuse server.js schemas (must connect to same DB)
const MovieSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  category: { type: String, default: "Feature Film" },
  genre: [{ type: String }],
  releaseDate: { type: String, default: "" },
  releaseTBA: { type: Boolean, default: false },
  director: { type: String, default: "" },
  producer: { type: String, default: "" },
  budget: { type: String, default: "" },
  language: { type: String, default: "Hindi" },
  languages: [{ type: String }],
  synopsis: { type: String, default: "" },
  posterUrl: { type: String, default: "" },
  thumbnailUrl: { type: String, default: "" },
  bannerUrl: { type: String, default: "" },
  runtime: { type: String, default: "" },
  imdbId: { type: String, default: "" },
  tmdbId: { type: String, default: "", index: true },
  imdbRating: { type: String, default: "" },
  imdbVotes: { type: String, default: "" },
  contentRating: { type: String, default: "" },
  productionId: { type: mongoose.Schema.Types.ObjectId, ref: "Production" },
  collaborators: [{ type: mongoose.Schema.Types.ObjectId, ref: "Production" }],
  cast: [{
    castId: { type: mongoose.Schema.Types.ObjectId, ref: "Cast", required: true },
    name: { type: String, default: "" },
    photo: { type: String, default: "" },
    type: { type: String, default: "Actor" },
    role: { type: String, default: "" },
  }],
  media: {
    trailer: {
      ytId: { type: String, default: "" },
      url: { type: String, default: "" },
      thumbnailUrl: { type: String, default: "" },
    },
    songs: [{
      title: { type: String, default: "" },
      singer: { type: String, default: "" },
      singerRef: [{ type: mongoose.Schema.Types.ObjectId, ref: "Cast" }],
      musicDirector: { type: String, default: "" },
      lyricist: { type: String, default: "" },
      ytId: { type: String, default: "" },
      url: { type: String, default: "" },
      thumbnailUrl: { type: String, default: "" },
    }],
  },
  boxOffice: {
    opening: { type: String, default: "TBA" },
    firstWeek: { type: String, default: "TBA" },
    total: { type: String, default: "TBA" },
  },
  boxOfficeDays: [{
    day: { type: Number, required: true },
    net: { type: String, default: "" },
    gross: { type: String, default: "" },
    date: { type: String, default: "" },
    note: { type: String, default: "" },
  }],
  verdict: { type: String, default: "Upcoming" },
  status: { type: String, default: "Upcoming" },
  reviews: [],
  news: [{ type: mongoose.Schema.Types.ObjectId, ref: "News" }],
  slug: { type: String, default: "", index: true },
  interestedYes: { type: Number, default: 0 },
  interestedNo: { type: Number, default: 0 },
  streamingOn: { type: String, default: "" },
  streamingUrl: { type: String, default: "" },
  ottReleaseDate: { type: String, default: "" },
  detailBlogId: { type: mongoose.Schema.Types.ObjectId, ref: "Blog", default: null },
  songBlogIds: { type: Map, of: mongoose.Schema.Types.ObjectId, default: {} },
  ottBlogId: { type: mongoose.Schema.Types.ObjectId, ref: "Blog", default: null },
  ottLiveBlogId: { type: mongoose.Schema.Types.ObjectId, ref: "Blog", default: null },
}, { timestamps: true });

const Movie = mongoose.models.Movie || mongoose.model("Movie", MovieSchema);

/**
 * Fields that must NOT be overwritten if they were manually set.
 * (i.e., admin-edited data should be preserved)
 */
const PROTECTED_FIELDS = [
  "slug", "reviews", "news", "interestedYes", "interestedNo",
  "detailBlogId", "songBlogIds", "ottBlogId", "ottLiveBlogId",
  "collaborators", "productionId",
];

/**
 * Find an existing movie in DB using multiple dedup strategies:
 *   1. IMDb ID match
 *   2. Slug match
 *   3. Title + year match
 */
async function findExistingMovie(merged) {
  const { title, releaseDate, imdbId, tmdbId, externalIds } = merged;

  // 1. TMDb ID (most reliable for scraper runs)
  if (tmdbId) {
    const found = await Movie.findOne({ tmdbId }).lean();
    if (found) return { doc: found, reason: "tmdbId" };
  }

  // 2. IMDb ID (second most reliable)
  if (imdbId) {
    const found = await Movie.findOne({ imdbId }).lean();
    if (found) return { doc: found, reason: "imdbId" };
  }

  // 2. Slug match
  const slug = makeSlug(title, releaseDate);
  if (slug) {
    const found = await Movie.findOne({ slug }).lean();
    if (found) return { doc: found, reason: "slug" };
  }

  // 3. Title + year (fuzzy)
  if (title && releaseDate) {
    const year = new Date(releaseDate).getFullYear();
    const found = await Movie.findOne({
      title: { $regex: new RegExp(`^${escapeRegex(title)}$`, "i") },
      releaseDate: { $regex: `^${year}` },
    }).lean();
    if (found) return { doc: found, reason: "title+year" };
  }

  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate that a merged movie has the minimum required fields.
 */
function validateMinimumFields(merged) {
  const errors = [];
  if (!merged.title) errors.push("title");
  if (!merged.releaseDate && !merged.releaseYear) errors.push("releaseDate");
  if (!merged.posterUrl) errors.push("posterUrl");
  if (!merged.synopsis || merged.synopsis.length < 20) errors.push("synopsis");
  return errors;
}

/**
 * Build the MongoDB $set payload from merged data.
 * Only sets non-empty fields; protects manually-edited fields.
 */
function buildUpdatePayload(merged, castEntries) {
  const set = {};

  const map = {
    title: merged.title,
    category: merged.category || "Feature Film",
    language: merged.language || "Hindi",
    languages: merged.languages || [],
    genre: merged.genres || [],
    releaseDate: merged.releaseDate || "",
    director: merged.director || "",
    producer: merged.producer || "",
    budget: merged.budget || "TBA",
    synopsis: merged.synopsis || "",
    posterUrl: merged.posterUrl || "",
    thumbnailUrl: merged.thumbnailUrl || merged.posterUrl || "",
    bannerUrl: merged.bannerUrl || "",
    runtime: merged.runtime || "",
    imdbId: merged.imdbId || "",
    tmdbId: merged.tmdbId || "",
    imdbRating: merged.imdbRating || "",
    imdbVotes: merged.imdbVotes || "",
    contentRating: merged.contentRating || "",
    verdict: merged.verdict || "Released",
    status: merged.status || "Released",
    "boxOffice.opening": merged.boxOffice?.opening || "TBA",
    "boxOffice.firstWeek": merged.boxOffice?.firstWeek || "TBA",
    "boxOffice.total": merged.boxOffice?.total || "TBA",
    streamingOn: merged.streamingOn || "",
    streamingUrl: merged.streamingUrl || "",
  };

  // Only include non-empty values
  for (const [k, v] of Object.entries(map)) {
    if (v !== null && v !== undefined && v !== "") {
      if (Array.isArray(v) ? v.length > 0 : true) {
        set[k] = v;
      }
    }
  }

  // Media — trailer
  if (merged.trailer?.ytId) {
    set["media.trailer.ytId"] = merged.trailer.ytId;
    set["media.trailer.url"] = merged.trailer.url || `https://www.youtube.com/watch?v=${merged.trailer.ytId}`;
    set["media.trailer.thumbnailUrl"] = `https://img.youtube.com/vi/${merged.trailer.ytId}/hqdefault.jpg`;
  }

  // Songs (only if we have some and movie doesn't already have them)
  if (merged.songs?.length > 0) {
    set["media.songs"] = merged.songs.map((s) => ({
      title: s.title || "",
      singer: s.singer || "",
      musicDirector: s.musicDirector || "",
      lyricist: s.lyricist || "",
      ytId: s.ytId || "",
      url: s.url || "",
      thumbnailUrl: s.thumbnailUrl || "",
    }));
  }

  // Cast entries
  if (castEntries?.length > 0) {
    set.cast = castEntries;
  }

  // Day-wise box office
  if (merged.boxOfficeDays?.length > 0) {
    set.boxOfficeDays = merged.boxOfficeDays;
  }

  return set;
}

/**
 * Insert or update a movie in MongoDB.
 *
 * @param {object} merged       — output from merger.js
 * @param {string} productionId — scraper's production ObjectId string
 * @param {object} stats        — shared stats object
 * @returns {{ action: "inserted"|"updated"|"skipped", movieId: string }}
 */
async function saveMovie(merged, productionId, stats) {
  // Validate minimum fields
  if (!stats?.force) {
    const errors = validateMinimumFields(merged);
    if (errors.length > 0) {
      logger.warn(`Movie "${merged.title}" skipped — missing: ${errors.join(", ")}`);
      return { action: "skipped", reason: `missing: ${errors.join(", ")}` };
    }
  } else {
    // Even if forced, we absolutely need a title to save it
    if (!merged.title) {
      logger.warn(`Movie skipped — missing title (cannot force)`);
      return { action: "skipped", reason: `missing title` };
    }
  }


  // Resolve cast/crew into DB references
  const castEntries = await resolveCastAndCrew(
    merged.cast,
    merged.crew,
    stats
  );

  // Find existing
  const existing = await findExistingMovie(merged);

  if (existing) {
    // ── UPDATE — only update missing/outdated fields
    const { doc, reason } = existing;
    const set = buildUpdatePayload(merged, castEntries);

    // Remove protected fields from set
    for (const f of PROTECTED_FIELDS) {
      delete set[f];
      delete set[`${f}`];
    }

    // Don't overwrite synopsis/director if already set by admin
    if (doc.synopsis && doc.synopsis.length > 50) delete set.synopsis;
    if (doc.director && doc.director.length > 2) delete set.director;
    if (doc.posterUrl && doc.posterUrl.startsWith("http")) delete set.posterUrl;

    // Don't overwrite cast if already has manual entries (>5 cast members)
    if (doc.cast && doc.cast.length > 5) delete set.cast;

    await Movie.findByIdAndUpdate(doc._id, { $set: set });

    // Link movie to cast members
    if (castEntries.length > 0) {
      await linkMovieToCast(castEntries, doc._id);
    }

    if (stats) stats.updated++;
    logger.info(`Movie updated: "${merged.title}" [${reason}]`, { id: doc._id });
    return { action: "updated", movieId: String(doc._id) };

  } else {
    // ── INSERT new movie
    const slug = makeSlug(merged.title, merged.releaseDate);

    // Check slug collision and append counter
    let finalSlug = slug;
    let attempt = 0;
    while (await Movie.findOne({ slug: finalSlug }).lean()) {
      finalSlug = `${slug}-${++attempt}`;
    }

    const movieDoc = new Movie({
      title: merged.title,
      category: merged.category || "Feature Film",
      language: merged.language || "Hindi",
      languages: merged.languages || [],
      genre: merged.genres || [],
      releaseDate: merged.releaseDate || "",
      releaseTBA: !merged.releaseDate,
      director: merged.director || "",
      producer: merged.producer || "",
      budget: merged.budget || "TBA",
      synopsis: merged.synopsis || "",
      posterUrl: merged.posterUrl || "",
      thumbnailUrl: merged.thumbnailUrl || merged.posterUrl || "",
      bannerUrl: merged.bannerUrl || "",
      runtime: merged.runtime || "",
      imdbId: merged.imdbId || "",
      tmdbId: merged.tmdbId || "",
      imdbRating: merged.imdbRating || "",
      imdbVotes: merged.imdbVotes || "",
      contentRating: merged.contentRating || "",

      collaborators: [],
      cast: castEntries,
      media: {
        trailer: merged.trailer
          ? {
            ytId: merged.trailer.ytId || "",
            url: merged.trailer.url || "",
            thumbnailUrl: merged.trailer.ytId
              ? `https://img.youtube.com/vi/${merged.trailer.ytId}/hqdefault.jpg`
              : "",
          }
          : { ytId: "", url: "", thumbnailUrl: "" },
        songs: (merged.songs || []).map((s) => ({
          title: s.title || "",
          singer: s.singer || "",
          musicDirector: s.musicDirector || "",
          lyricist: s.lyricist || "",
          ytId: s.ytId || "",
          url: s.url || "",
          thumbnailUrl: s.thumbnailUrl || "",
        })),
      },
      boxOffice: {
        opening: merged.boxOffice?.opening || "TBA",
        firstWeek: merged.boxOffice?.firstWeek || "TBA",
        total: merged.boxOffice?.total || "TBA",
      },
      boxOfficeDays: merged.boxOfficeDays || [],
      verdict: merged.verdict || "Released",
      status: merged.status || "Released",
      slug: finalSlug,
      interestedYes: 0,
      interestedNo: 0,
    });

    const saved = await movieDoc.save();

    // Link movie to cast members
    if (castEntries.length > 0) {
      await linkMovieToCast(castEntries, saved._id);
    }

    if (stats) stats.inserted++;
    logger.info(`Movie inserted: "${merged.title}" [${finalSlug}]`, { id: saved._id });
    return { action: "inserted", movieId: String(saved._id) };
  }
}

module.exports = { saveMovie, findExistingMovie, validateMinimumFields };
