// -----------------------------------------------------------------------------
//  scrapers/tmdb-regional.js - TMDB API scraper for regional movies
//  Parameterized version of tmdb scraper for languages like Telugu, Malayalam, Bengali
// -----------------------------------------------------------------------------
"use strict";

const { TMDB_API_KEY, TMDB_BASE, TMDB_IMG_BASE, POSTER_SIZE, BACKDROP_SIZE, PROFILE_SIZE } = require("../config");
const { getJSON } = require("../utils/http");
const logger = require("../utils/logger");

if (!TMDB_API_KEY) {
  logger.warn("TMDB_API_KEY not set - Regional TMDB scraper will be unavailable.");
}

const BASE = TMDB_BASE;
const KEY = TMDB_API_KEY;

function imgUrl(path, size = POSTER_SIZE) {
  if (!path) return "";
  return `${TMDB_IMG_BASE}/${size}${path}`;
}

/**
 * Fetch paginated list of regional movies released in a specific year.
 */
async function fetchRegionalMoviesByYear(year, tmdbLang, page = 1) {
  if (!KEY) return { results: [], totalPages: 0 };
  try {
    const url = `${BASE}/discover/movie?api_key=${KEY}&with_original_language=${tmdbLang}&primary_release_year=${year}&sort_by=popularity.desc&page=${page}&include_adult=false&with_release_type=3%7C2`;
    const data = await getJSON(url);
    return {
      results: data.results || [],
      totalPages: data.total_pages || 1,
      totalResults: data.total_results || 0,
    };
  } catch (err) {
    logger.error(`TMDB fetchRegionalMoviesByYear failed [${tmdbLang}]`, { year, page, err: err.message });
    return { results: [], totalPages: 0 };
  }
}

/**
 * Fetch ALL pages of regional movies for a year.
 */
async function fetchAllRegionalMoviesByYear(year, tmdbLang) {
  const first = await fetchRegionalMoviesByYear(year, tmdbLang, 1);
  if (!first.results.length) return [];

  const allMovies = [...first.results];
  const totalPages = Math.min(first.totalPages, 25); // cap at 25 pages (~500 movies/year)

  for (let page = 2; page <= totalPages; page++) {
    const { results } = await fetchRegionalMoviesByYear(year, tmdbLang, page);
    allMovies.push(...results);
  }

  return allMovies;
}

/**
 * Fetch paginated list of regional movies released in the last 6 months.
 */
async function fetchRecentRegionalMovies(tmdbLang, page = 1) {
  if (!KEY) return { results: [], totalPages: 0 };
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const dateStr = sixMonthsAgo.toISOString().split("T")[0];

    const url = `${BASE}/discover/movie?api_key=${KEY}&with_original_language=${tmdbLang}&primary_release_date.gte=${dateStr}&sort_by=popularity.desc&page=${page}&include_adult=false&with_release_type=3%7C2`;
    const data = await getJSON(url);
    return {
      results: data.results || [],
      totalPages: data.total_pages || 1,
      totalResults: data.total_results || 0,
    };
  } catch (err) {
    logger.error(`TMDB fetchRecentRegionalMovies failed [${tmdbLang}]`, { page, err: err.message });
    return { results: [], totalPages: 0 };
  }
}

/**
 * Fetch ALL pages of recent regional movies (last 6 months).
 */
async function fetchAllRecentRegionalMovies(tmdbLang) {
  const first = await fetchRecentRegionalMovies(tmdbLang, 1);
  if (!first.results.length) return [];

  const allMovies = [...first.results];
  const totalPages = Math.min(first.totalPages, 25); // cap at 25 pages

  for (let page = 2; page <= totalPages; page++) {
    const { results } = await fetchRecentRegionalMovies(tmdbLang, page);
    allMovies.push(...results);
  }

  return allMovies;
}

/**
 * Fetch full movie details from TMDB including credits, images, videos, keywords.
 */
async function fetchRegionalMovieDetails(tmdbId) {
  if (!KEY) return null;
  try {
    const url = `${BASE}/movie/${tmdbId}?api_key=${KEY}&append_to_response=credits,images,videos,keywords,release_dates,external_ids,recommendations,watch/providers`;
    const d = await getJSON(url);
    return d;
  } catch (err) {
    logger.error("TMDB fetchRegionalMovieDetails failed", { tmdbId, err: err.message });
    return null;
  }
}

/**
 * Map raw TMDB movie data to normalized scraper format for regional movies.
 */
function mapTmdbRegionalMovie(d, langName) {
  if (!d) return null;

  const releaseDate = d.release_date || "";
  const year = releaseDate ? new Date(releaseDate).getFullYear() : null;

  const languages = (d.spoken_languages || []).map(l => l.english_name);

  const genres = (d.genres || []).map((g) => g.name);
  const productionCompanies = (d.production_companies || []).map((p) => p.name);

  // Credits - cast (top 30)
  const castRaw = (d.credits?.cast || []).slice(0, 30);
  const cast = castRaw.map((c) => ({
    tmdbId: c.id,
    name: c.name || "",
    character: c.character || "",
    photo: imgUrl(c.profile_path, PROFILE_SIZE),
    order: c.order,
    gender: c.gender === 1 ? "Female" : c.gender === 2 ? "Male" : "",
    type: "Actor",
  }));

  // Credits - crew
  const crewRaw = d.credits?.crew || [];
  const crewMap = {};
  const crewRoles = [
    { job: "Director",              type: "Director" },
    { job: "Producer",              type: "Producer" },
    { job: "Executive Producer",    type: "Producer" },
    { job: "Screenplay",            type: "Writer" },
    { job: "Story",                 type: "Writer" },
    { job: "Writer",                type: "Writer" },
    { job: "Dialogue",              type: "Writer" },
    { job: "Director of Photography", type: "Cinematographer" },
    { job: "Original Music Composer", type: "Music Director" },
    { job: "Editor",                type: "Editor" },
    { job: "Casting",               type: "Casting Director" },
    { job: "Costume Design",        type: "Costume Designer" },
    { job: "Production Design",     type: "Production Designer" },
  ];

  for (const member of crewRaw) {
    for (const { job, type } of crewRoles) {
      if (member.job === job) {
        if (!crewMap[type]) crewMap[type] = [];
        crewMap[type].push({
          tmdbId: member.id,
          name: member.name || "",
          photo: imgUrl(member.profile_path, PROFILE_SIZE),
          type,
          job: member.job,
        });
      }
    }
  }

  // Images
  const posters = (d.images?.posters || []).slice(0, 5).map((p) => imgUrl(p.file_path, POSTER_SIZE));
  const backdrops = (d.images?.backdrops || []).slice(0, 3).map((b) => imgUrl(b.file_path, BACKDROP_SIZE));

  // Videos - trailer/teaser
  const videos = (d.videos?.results || []);
  const trailer = videos.find((v) => v.type === "Trailer" && v.site === "YouTube")
    || videos.find((v) => v.type === "Teaser" && v.site === "YouTube")
    || null;

  // Keywords
  const keywords = (d.keywords?.keywords || []).map((k) => k.name);

  // External IDs
  const imdbId = d.external_ids?.imdb_id || d.imdb_id || "";

  // Indian certification
  const certEntry = (d.release_dates?.results || []).find((r) => r.iso_3166_1 === "IN");
  const certification = certEntry?.release_dates?.[0]?.certification || "";

  // OTT Providers (India)
  let streamingOn = "";
  let streamingUrl = "";
  const inProviders = d["watch/providers"]?.results?.IN;
  if (inProviders) {
    const flatrate = inProviders.flatrate?.[0];
    const free = inProviders.free?.[0];
    const provider = flatrate || free;
    if (provider) {
      streamingOn = provider.provider_name;
      streamingUrl = inProviders.link || "";
    }
  }

  const budgetUSD = d.budget || 0;
  const revenueUSD = d.revenue || 0;

  return {
    source: "tmdb",
    tmdbId: d.id,
    imdbId,
    title: d.title || "",
    originalTitle: d.original_title || "",
    tagline: d.tagline || "",
    synopsis: d.overview || "",
    releaseDate,
    year,
    runtime: d.runtime || 0,
    language: langName, // Dynamically set language
    languages,
    genres,
    certification,
    status: mapStatus(d.status),
    posterUrl: imgUrl(d.poster_path, POSTER_SIZE),
    bannerUrl: imgUrl(d.backdrop_path, BACKDROP_SIZE),
    posters,
    backdrops,
    budgetUSD,
    revenueUSD,
    productionCompanies,
    website: d.homepage || "",
    popularity: d.popularity || 0,
    voteAverage: d.vote_average || 0,
    voteCount: d.vote_count || 0,
    cast,
    crew: crewMap,
    trailer: trailer
      ? { ytId: trailer.key, url: `https://www.youtube.com/watch?v=${trailer.key}` }
      : null,
    keywords,
    tmdbRating: d.vote_average ? String(d.vote_average.toFixed(1)) : "",
    streamingOn,
    streamingUrl,
  };
}

function mapStatus(tmdbStatus) {
  const map = {
    "Released": "Released",
    "Post Production": "Post Production",
    "In Production": "Upcoming",
    "Planned": "Upcoming",
    "Rumored": "Upcoming",
    "Canceled": "Released",
  };
  return map[tmdbStatus] || "Released";
}

/**
 * Search TMDB for a movie by title and year.
 */
async function searchRegionalMovie(title, year) {
  if (!KEY) return [];
  try {
    const url = `${BASE}/search/movie?api_key=${KEY}&query=${encodeURIComponent(title)}&year=${year}&language=en-US`;
    const data = await getJSON(url);
    return data.results || [];
  } catch (err) {
    logger.warn("TMDB search failed", { title, year, err: err.message });
    return [];
  }
}

/**
 * Fetch a person's details from TMDB.
 */
async function fetchRegionalPerson(tmdbPersonId) {
  if (!KEY) return null;
  try {
    const url = `${BASE}/person/${tmdbPersonId}?api_key=${KEY}&append_to_response=external_ids,images`;
    return await getJSON(url);
  } catch (err) {
    logger.warn("TMDB fetchPerson failed", { tmdbPersonId, err: err.message });
    return null;
  }
}

module.exports = {
  fetchAllRegionalMoviesByYear,
  fetchAllRecentRegionalMovies,
  fetchRegionalMoviesByYear,
  fetchRegionalMovieDetails,
  mapTmdbRegionalMovie,
  searchRegionalMovie,
  fetchRegionalPerson,
  imgUrl,
};
