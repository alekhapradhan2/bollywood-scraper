// ─────────────────────────────────────────────────────────────────────────────
//  enrichers/merger.js — Multi-source data merger with confidence scoring
//  Combines TMDB + OMDb + Wikipedia + scrapers into one authoritative record.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const {
  pickBest, normalizeGenres, normalizeDate, parseRuntime, formatRuntime,
  cleanText, validateUrl, dedupeBy, parseCurrencyToINR, formatINR,
  normalizeName,
} = require("../utils/normalizer");

const WEIGHTS = {
  tmdb: 1.0,
  omdb: 0.9,
  imdb: 0.95,
  wikipedia: 0.85,
  bollywood_hungama: 0.70,
  sacnilk: 0.75,
  filmibeat: 0.65,
  youtube: 0.60,
};

function w(source) { return WEIGHTS[source] || 0.5; }

/**
 * Merge data from all sources into a single canonical movie object.
 *
 * @param {object} sources  — { tmdb, omdb, wikipedia, bollywoodhungama, sacnilk, youtube }
 * @returns {object}        merged movie data
 */
function mergeMovieData(sources) {
  const { tmdb, omdb, wikipedia, bollywoodhungama, sacnilk, youtube } = sources;

  // ── Title — TMDB is most reliable for Hindi movies
  const title = pickBest([
    tmdb && { value: tmdb.title, source: "tmdb", conf: w("tmdb") },
    omdb && { value: omdb.title, source: "omdb", conf: w("omdb") },
    wikipedia && { value: wikipedia.infobox?.["name"] || wikipedia.pageTitle?.replace(/ \(film\).*$/, "").trim(), source: "wikipedia", conf: w("wikipedia") },
  ].filter(Boolean)) || "";

  // ── Original title
  const originalTitle = tmdb?.originalTitle || title;

  // ── Release date
  const releaseDateRaw = pickBest([
    tmdb && { value: normalizeDate(tmdb.releaseDate), source: "tmdb", conf: w("tmdb") },
    omdb && { value: normalizeDate(omdb.releaseDate), source: "omdb", conf: w("omdb") },
  ].filter(Boolean)) || "";

  const releaseYear = releaseDateRaw
    ? new Date(releaseDateRaw).getFullYear()
    : (tmdb?.year || omdb?.year || null);

  // ── Runtime (minutes → "Xh Ym")
  const runtimeMin = pickBest([
    tmdb && tmdb.runtime > 0 && { value: tmdb.runtime, source: "tmdb", conf: w("tmdb") },
    omdb && omdb.runtime > 0 && { value: omdb.runtime, source: "omdb", conf: w("omdb") },
    wikipedia && { value: parseRuntime(wikipedia.runtime), source: "wikipedia", conf: w("wikipedia") },
  ].filter(Boolean)) || 0;
  const runtime = runtimeMin ? formatRuntime(runtimeMin) : "";

  // ── Synopsis / Plot — prefer longer, more detailed version
  const synopsisCandidates = [
    omdb?.plot && { value: omdb.plot, source: "omdb", conf: w("omdb") * (omdb.plot.length / 500) },
    wikipedia?.plot && { value: wikipedia.plot, source: "wikipedia", conf: w("wikipedia") * (wikipedia.plot.length / 1000) },
    tmdb?.synopsis && { value: tmdb.synopsis, source: "tmdb", conf: w("tmdb") * (tmdb.synopsis.length / 300) },
    wikipedia?.extract && { value: wikipedia.extract, source: "wikipedia", conf: w("wikipedia") * 0.8 },
    bollywoodhungama?.synopsis && { value: bollywoodhungama.synopsis, source: "bollywood_hungama", conf: w("bollywood_hungama") },
  ].filter(Boolean);
  const synopsis = pickBest(synopsisCandidates.sort((a, b) => b.conf - a.conf)) || "";

  // ── Genres
  const allGenres = [
    ...(tmdb?.genres || []),
    ...(omdb?.genres || []),
  ];
  const genres = normalizeGenres(dedupeBy(allGenres.map((g) => ({ name: g })), (x) => x.name.toLowerCase()).map((x) => x.name));

  // ── Director
  const director = pickBest([
    tmdb?.crew?.Director?.[0] && { value: tmdb.crew.Director[0].name, source: "tmdb", conf: w("tmdb") },
    omdb?.director && { value: omdb.director.split(",")[0].trim(), source: "omdb", conf: w("omdb") },
    wikipedia?.director && { value: wikipedia.director.split(",")[0].trim(), source: "wikipedia", conf: w("wikipedia") },
    bollywoodhungama?.director && { value: bollywoodhungama.director, source: "bollywood_hungama", conf: w("bollywood_hungama") },
  ].filter((c) => c && c.value)) || "";

  // ── Producer
  const producer = pickBest([
    tmdb?.crew?.Producer?.[0] && { value: tmdb.crew.Producer.map((p) => p.name).join(", "), source: "tmdb", conf: w("tmdb") },
    tmdb?.productionCompanies?.length > 0 && { value: tmdb.productionCompanies.join(", "), source: "tmdb", conf: w("tmdb") * 0.9 },
    wikipedia?.producer && { value: wikipedia.producer, source: "wikipedia", conf: w("wikipedia") },
    omdb?.production && { value: omdb.production, source: "omdb", conf: w("omdb") },
  ].filter((c) => c && c.value)) || "";

  // ── Writer
  const writer = pickBest([
    tmdb?.crew?.Writer?.[0] && { value: tmdb.crew.Writer.map((p) => p.name).join(", "), source: "tmdb", conf: w("tmdb") },
    omdb?.writer && { value: omdb.writer, source: "omdb", conf: w("omdb") },
    wikipedia?.writer && { value: wikipedia.writer, source: "wikipedia", conf: w("wikipedia") },
  ].filter((c) => c && c.value)) || "";

  // ── Music director
  const musicDirector = pickBest([
    tmdb?.crew?.["Music Director"]?.[0] && { value: tmdb.crew["Music Director"].map((p) => p.name).join(", "), source: "tmdb", conf: w("tmdb") },
    wikipedia?.music && { value: wikipedia.music, source: "wikipedia", conf: w("wikipedia") },
  ].filter((c) => c && c.value)) || "";

  // ── Poster
  const posterUrl = pickBest([
    tmdb?.posterUrl && { value: tmdb.posterUrl, source: "tmdb", conf: w("tmdb") },
    omdb?.posterUrl && { value: omdb.posterUrl, source: "omdb", conf: w("omdb") * 0.7 },
    wikipedia?.thumbnail && { value: wikipedia.thumbnail, source: "wikipedia", conf: w("wikipedia") * 0.6 },
  ].filter((c) => c && c.value)) || "";

  const bannerUrl = tmdb?.bannerUrl || "";

  // ── Trailer
  let trailer = null;
  if (tmdb?.trailer?.ytId) {
    trailer = tmdb.trailer;
  } else if (youtube?.trailer?.ytId) {
    trailer = youtube.trailer;
  }

  // ── IMDb data
  const imdbId = tmdb?.imdbId || omdb?.imdbId || "";
  const imdbRating = omdb?.imdbRating || tmdb?.tmdbRating || "";
  const imdbVotes = omdb?.imdbVotes || "";

  // ── Certification (content rating)
  const contentRating = pickBest([
    tmdb?.certification && { value: tmdb.certification, source: "tmdb", conf: w("tmdb") },
    omdb?.contentRating && { value: omdb.contentRating, source: "omdb", conf: w("omdb") },
  ].filter((c) => c && c.value)) || "";

  // ── Budget
  const budgetINR = pickBest([
    tmdb?.budgetUSD > 0 && { value: formatINR(tmdb.budgetUSD * 83), source: "tmdb", conf: w("tmdb") },
    wikipedia?.budget && { value: wikipedia.budget, source: "wikipedia", conf: w("wikipedia") },
    bollywoodhungama?.budget && { value: bollywoodhungama.budget, source: "bollywood_hungama", conf: w("bollywood_hungama") },
  ].filter((c) => c && c.value)) || "TBA";

  // ── Box office
  const totalCollection = pickBest([
    sacnilk?.total && { value: sacnilk.total, source: "sacnilk", conf: w("sacnilk") },
    bollywoodhungama?.boxOffice?.total && { value: bollywoodhungama.boxOffice.total, source: "bollywood_hungama", conf: w("bollywood_hungama") },
    wikipedia?.boxOffice && { value: wikipedia.boxOffice, source: "wikipedia", conf: w("wikipedia") },
    tmdb?.revenueUSD > 0 && { value: formatINR(tmdb.revenueUSD * 83), source: "tmdb", conf: w("tmdb") * 0.6 },
  ].filter((c) => c && c.value)) || "TBA";

  const openingCollection = pickBest([
    sacnilk?.opening && { value: sacnilk.opening, source: "sacnilk", conf: w("sacnilk") },
    bollywoodhungama?.boxOffice?.opening && { value: bollywoodhungama.boxOffice.opening, source: "bollywood_hungama", conf: w("bollywood_hungama") },
  ].filter((c) => c && c.value)) || "TBA";

  const firstWeekCollection = pickBest([
    sacnilk?.firstWeek && { value: sacnilk.firstWeek, source: "sacnilk", conf: w("sacnilk") },
    bollywoodhungama?.boxOffice?.firstWeek && { value: bollywoodhungama.boxOffice.firstWeek, source: "bollywood_hungama", conf: w("bollywood_hungama") },
  ].filter((c) => c && c.value)) || "TBA";

  // ── Status and verdict
  let status = tmdb?.status || "Released";
  let verdict = deriveVerdict(imdbRating);

  // If the release date is in the future, override status and verdict to Upcoming
  if (releaseDateRaw) {
    const releaseDateObj = new Date(releaseDateRaw);
    const today = new Date();
    // Reset time to compare only dates
    releaseDateObj.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    
    if (releaseDateObj > today) {
      status = "Upcoming";
      verdict = "Upcoming";
    }
  }

  // ── Website
  const website = validateUrl(pickBest([
    tmdb?.website && { value: tmdb.website, source: "tmdb", conf: w("tmdb") },
    omdb?.website && { value: omdb.website, source: "omdb", conf: w("omdb") },
    wikipedia?.infobox?.website && { value: wikipedia.infobox.website, source: "wikipedia", conf: w("wikipedia") },
  ].filter((c) => c && c.value)) || "");

  // ── Keywords
  const keywords = [...new Set([
    ...(tmdb?.keywords || []),
    title, director, ...genres,
  ].filter(Boolean))].slice(0, 30);

  // ── Awards
  const awards = omdb?.awards || "";

  // ── Build cast array (from TMDB primarily)
  const castArray = buildCastArray(tmdb, bollywoodhungama);

  // ── External IDs for cross-referencing
  const externalIds = {
    tmdbId: tmdb?.tmdbId || null,
    imdbId,
  };

  // ── OTT Providers
  const streamingOn = tmdb?.streamingOn || "";
  const streamingUrl = tmdb?.streamingUrl || "";

  return {
    title: cleanText(title),
    originalTitle: cleanText(originalTitle),
    language: tmdb?.language || "Hindi",
    category: "Feature Film",
    releaseDate: releaseDateRaw,
    releaseYear,
    runtime,
    synopsis: cleanText(synopsis),
    director: cleanText(director),
    producer: cleanText(producer),
    writer: cleanText(writer),
    musicDirector: cleanText(musicDirector),
    genres,
    status,
    verdict,
    posterUrl: validateUrl(posterUrl),
    bannerUrl: validateUrl(bannerUrl),
    thumbnailUrl: validateUrl(posterUrl), // use poster as thumbnail fallback
    imdbId,
    tmdbId: tmdb?.tmdbId || "",
    imdbRating,
    imdbVotes,
    tmdbRating: tmdb?.tmdbRating || "",
    contentRating,
    budget: budgetINR,
    boxOffice: {
      opening: openingCollection,
      firstWeek: firstWeekCollection,
      total: totalCollection,
    },
    website,
    tagline: cleanText(tmdb?.tagline || ""),
    keywords,
    awards,
    cast: castArray,
    crew: tmdb?.crew || {},
    trailer,
    posters: tmdb?.posters || [],
    backdrops: tmdb?.backdrops || [],
    externalIds,
    productionCompanies: tmdb?.productionCompanies || [],
    streamingOn,
    streamingUrl,
    _tmdbData: tmdb,
    _omdbData: omdb,
  };
}

/**
 * Build cast array merging TMDB cast with BollywoodHungama.
 */
function buildCastArray(tmdb, bh) {
  const castMap = new Map();

  // TMDB cast (highest confidence)
  for (const c of tmdb?.cast || []) {
    const key = c.name.toLowerCase().trim();
    castMap.set(key, {
      name: c.name,
      photo: c.photo || "",
      character: c.character || "",
      type: "Actor",
      tmdbPersonId: c.tmdbId,
      gender: c.gender || "",
      order: c.order || 999,
    });
  }

  // BH cast — fill in gaps
  for (const c of bh?.cast || []) {
    const key = normalizeName(c.name).toLowerCase();
    if (!castMap.has(key) && c.name) {
      castMap.set(key, {
        name: normalizeName(c.name),
        photo: "",
        character: c.role || "",
        type: c.type || "Actor",
        tmdbPersonId: null,
        order: 999,
      });
    }
  }

  return [...castMap.values()].sort((a, b) => a.order - b.order);
}

/**
 * Derive verdict based on IMDb/TMDB rating.
 */
function deriveVerdict(imdbRating) {
  if (!imdbRating) return "Released";
  const rating = parseFloat(imdbRating);
  if (isNaN(rating)) return "Released";

  if (rating >= 8) return "Blockbuster";
  if (rating >= 7) return "Hit";
  if (rating < 3) return "Flop";
  if (rating < 5) return "Average";
  
  return "Released";
}

module.exports = { mergeMovieData };
