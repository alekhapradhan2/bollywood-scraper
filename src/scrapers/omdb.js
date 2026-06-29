// ─────────────────────────────────────────────────────────────────────────────
//  scrapers/omdb.js — OMDb API scraper (IMDb data, awards, ratings)
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { OMDB_API_KEY, OMDB_BASE } = require("../config");
const { getJSON } = require("../utils/http");
const logger = require("../utils/logger");

if (!OMDB_API_KEY) {
  logger.warn("OMDB_API_KEY not set — OMDb enrichment will be skipped.");
}

/**
 * Fetch movie data from OMDb by IMDb ID.
 * @param {string} imdbId  — e.g. "tt1234567"
 * @returns {object|null}
 */
async function fetchByImdbId(imdbId) {
  if (!OMDB_API_KEY || !imdbId) return null;
  try {
    const url = `${OMDB_BASE}/?apikey=${OMDB_API_KEY}&i=${imdbId}&type=movie&plot=full`;
    const d = await getJSON(url);
    if (d.Response === "False") return null;
    return d;
  } catch (err) {
    logger.warn("OMDb fetchByImdbId failed", { imdbId, err: err.message });
    return null;
  }
}

/**
 * Search OMDb by title and year.
 */
async function searchByTitle(title, year) {
  if (!OMDB_API_KEY) return null;
  try {
    const url = `${OMDB_BASE}/?apikey=${OMDB_API_KEY}&t=${encodeURIComponent(title)}&y=${year}&type=movie&plot=full`;
    const d = await getJSON(url);
    if (d.Response === "False") return null;
    return d;
  } catch (err) {
    logger.warn("OMDb searchByTitle failed", { title, year, err: err.message });
    return null;
  }
}

/**
 * Map OMDb raw response to our normalized format.
 */
function mapOmdbData(d) {
  if (!d || d.Response === "False") return null;

  // Parse ratings
  const ratings = {};
  for (const r of d.Ratings || []) {
    if (r.Source === "Internet Movie Database") ratings.imdb = r.Value;
    if (r.Source === "Rotten Tomatoes") ratings.rottenTomatoes = r.Value;
    if (r.Source === "Metacritic") ratings.metacritic = r.Value;
  }

  // Parse runtime
  const runtimeMin = d.Runtime
    ? parseInt(String(d.Runtime).replace(/\D/g, "")) || 0
    : 0;

  // Parse box office (US dollars)
  const parseBoxOfficeUSD = (s) => {
    if (!s || s === "N/A") return 0;
    return parseInt(s.replace(/[$,]/g, "")) || 0;
  };

  return {
    source: "omdb",
    imdbId: d.imdbID || "",
    title: d.Title || "",
    year: parseInt(d.Year) || null,
    releaseDate: d.Released && d.Released !== "N/A" ? d.Released : "",
    runtime: runtimeMin,
    genres: d.Genre && d.Genre !== "N/A"
      ? d.Genre.split(",").map((g) => g.trim())
      : [],
    director: d.Director && d.Director !== "N/A" ? d.Director : "",
    writer: d.Writer && d.Writer !== "N/A" ? d.Writer : "",
    actors: d.Actors && d.Actors !== "N/A" ? d.Actors : "",
    plot: d.Plot && d.Plot !== "N/A" ? d.Plot : "",
    language: d.Language || "",
    country: d.Country || "",
    awards: d.Awards && d.Awards !== "N/A" ? d.Awards : "",
    posterUrl: d.Poster && d.Poster !== "N/A" ? d.Poster : "",
    ratings,
    imdbRating: d.imdbRating && d.imdbRating !== "N/A" ? d.imdbRating : "",
    imdbVotes: d.imdbVotes && d.imdbVotes !== "N/A" ? d.imdbVotes : "",
    metascore: d.Metascore && d.Metascore !== "N/A" ? d.Metascore : "",
    boxOfficeUSD: parseBoxOfficeUSD(d.BoxOffice),
    production: d.Production && d.Production !== "N/A" ? d.Production : "",
    website: d.Website && d.Website !== "N/A" ? d.Website : "",
    dvd: d.DVD && d.DVD !== "N/A" ? d.DVD : "",
    contentRating: d.Rated && d.Rated !== "N/A" ? d.Rated : "",
    type: d.Type || "movie",
  };
}

module.exports = { fetchByImdbId, searchByTitle, mapOmdbData };
