// ─────────────────────────────────────────────────────────────────────────────
//  enrichers/castResolver.js — Resolve cast/crew against existing DB records
//  Finds existing Cast documents by name (exact + fuzzy), creates new ones.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");
const { normalizeName, validateUrl } = require("../utils/normalizer");
const { fetchPerson, imgUrl } = require("../scrapers/tmdb");
const logger = require("../utils/logger");

// ── Cast schema (matches server.js exactly)
const CastSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  type: { type: String, default: "Actor" },
  roles: [{ type: String }],
  bio: { type: String, default: "" },
  photo: { type: String, default: "" },
  dob: { type: String, default: "" },
  gender: { type: String, default: "" },
  location: { type: String, default: "" },
  website: { type: String, default: "" },
  instagram: { type: String, default: "" },
  banner: { type: String, default: "" },
  movies: [{ type: mongoose.Schema.Types.ObjectId, ref: "Movie" }],
}, { timestamps: true });

// Use existing model if already registered (shared process with server)
const Cast = mongoose.models.Cast || mongoose.model("Cast", CastSchema);

// In-memory cache to avoid DB lookups for same person within a run
const _cache = new Map();

/**
 * Find an existing Cast document by name (case-insensitive).
 * @param {string} name
 * @returns {object|null} Cast document
 */
async function findCastByName(name) {
  const key = name.toLowerCase().trim();
  if (_cache.has(key)) return _cache.get(key);

  const doc = await Cast.findOne({
    name: { $regex: new RegExp(`^${escapeRegex(name.trim())}$`, "i") },
  }).lean();

  if (doc) _cache.set(key, doc);
  return doc || null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Create a new Cast document if it doesn't already exist.
 * Optionally enriches with TMDB person data.
 */
async function findOrCreateCast(personData, stats) {
  const name = normalizeName(personData.name || "");
  if (!name) return null;

  // 1. Try to find by name
  const existing = await findCastByName(name);
  if (existing) {
    // Update photo if we have a better one
    if (!existing.photo && personData.photo) {
      await Cast.findByIdAndUpdate(existing._id, { $set: { photo: personData.photo } });
    }
    if (stats) stats.castReused++;
    return existing;
  }

  // 2. Optionally fetch enriched data from TMDB person endpoint
  let tmdbPerson = null;
  if (personData.tmdbPersonId) {
    tmdbPerson = await fetchPerson(personData.tmdbPersonId).catch(() => null);
  }

  // 3. Build the new Cast document
  const photo = validateUrl(
    personData.photo
    || (tmdbPerson?.profile_path ? imgUrl(tmdbPerson.profile_path, "w185") : "")
  );

  const newCast = new Cast({
    name,
    type: personData.type || "Actor",
    roles: [personData.type || "Actor"],
    bio: tmdbPerson?.biography ? tmdbPerson.biography.slice(0, 2000) : "",
    photo,
    dob: tmdbPerson?.birthday || "",
    gender: personData.gender || (tmdbPerson?.gender === 1 ? "Female" : tmdbPerson?.gender === 2 ? "Male" : ""),
    location: tmdbPerson?.place_of_birth || "",
    website: validateUrl(tmdbPerson?.homepage || ""),
    instagram: "",
    banner: "",
    movies: [],
  });

  try {
    const saved = await newCast.save();
    const obj = saved.toObject();
    _cache.set(name.toLowerCase().trim(), obj);
    if (stats) stats.castCreated++;
    logger.info(`Cast created: ${name} (${personData.type})`);
    return obj;
  } catch (err) {
    // Duplicate key — race condition; fetch what was just inserted
    if (err.code === 11000 || err.message?.includes("duplicate")) {
      const found = await findCastByName(name);
      if (found) {
        if (stats) stats.castReused++;
        return found;
      }
    }
    logger.error("Cast creation failed", { name, err: err.message });
    return null;
  }
}

/**
 * Resolve a full cast+crew array against the DB.
 * Returns array of CastEntry objects ready for Movie.cast[].
 *
 * @param {Array} castArray    — merged cast from merger.js
 * @param {Array} crewMap      — { Director: [...], Producer: [...], ... }
 * @param {object} stats       — shared stats counters
 */
async function resolveCastAndCrew(castArray, crewMap, stats) {
  const entries = [];

  // ── Resolve actors
  for (const person of (castArray || [])) {
    const castDoc = await findOrCreateCast(person, stats);
    if (!castDoc) continue;
    entries.push({
      castId: castDoc._id,
      name: castDoc.name,
      photo: castDoc.photo || person.photo || "",
      type: "Actor",
      role: person.character || "",
    });
  }

  // ── Resolve crew
  for (const [type, members] of Object.entries(crewMap || {})) {
    for (const member of (Array.isArray(members) ? members : [])) {
      const castDoc = await findOrCreateCast({ ...member, type }, stats);
      if (!castDoc) continue;
      entries.push({
        castId: castDoc._id,
        name: castDoc.name,
        photo: castDoc.photo || member.photo || "",
        type,
        role: member.job || type,
      });
    }
  }

  return entries;
}

/**
 * Link a movieId back to all cast members' movies[] array.
 */
async function linkMovieToCast(castEntries, movieId) {
  const castIds = [...new Set(castEntries.map((e) => String(e.castId)))];
  if (!castIds.length) return;
  await Cast.updateMany(
    { _id: { $in: castIds }, movies: { $ne: movieId } },
    { $addToSet: { movies: movieId } }
  );
}

module.exports = { findOrCreateCast, resolveCastAndCrew, linkMovieToCast, findCastByName };
