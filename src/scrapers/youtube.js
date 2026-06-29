// ─────────────────────────────────────────────────────────────────────────────
//  scrapers/youtube.js — YouTube Data API v3 for trailers, teasers, songs
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { getJSON } = require("../utils/http");
const { extractYtId } = require("../utils/normalizer");
const logger = require("../utils/logger");

const YT_API_KEY = process.env.YOUTUBE_API_KEY || "";
const YT_BASE = "https://www.googleapis.com/youtube/v3";

if (!YT_API_KEY) {
  logger.warn("YOUTUBE_API_KEY not set — YouTube enrichment will be limited.");
}

/**
 * Search YouTube for a movie's official trailer.
 * @param {string} title
 * @param {number} year
 * @returns {object|null} { ytId, title, thumbnailUrl, channelTitle }
 */
async function searchTrailer(title, year) {
  if (!YT_API_KEY) return null;
  try {
    const query = `${title} ${year} official trailer Hindi`;
    const url = `${YT_BASE}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=5&key=${YT_API_KEY}&videoCategoryId=1`;
    const data = await getJSON(url);
    const items = data.items || [];

    // Prefer official channel or "official" in title
    const trailer = items.find((item) => {
      const t = (item.snippet?.title || "").toLowerCase();
      const ch = (item.snippet?.channelTitle || "").toLowerCase();
      return (t.includes("official") || ch.includes("official") || ch.includes(title.toLowerCase().split(" ")[0]))
        && (t.includes("trailer") || t.includes("teaser"));
    }) || items[0];

    if (!trailer) return null;

    const ytId = trailer.id?.videoId || "";
    return {
      ytId,
      url: `https://www.youtube.com/watch?v=${ytId}`,
      title: trailer.snippet?.title || "",
      thumbnailUrl: trailer.snippet?.thumbnails?.high?.url || `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`,
      channelTitle: trailer.snippet?.channelTitle || "",
    };
  } catch (err) {
    logger.warn("YouTube trailer search failed", { title, year, err: err.message });
    return null;
  }
}

/**
 * Search YouTube for a movie's songs.
 * Returns array of up to 10 song results.
 */
async function searchSongs(title, year) {
  if (!YT_API_KEY) return [];
  try {
    const query = `${title} ${year} full song Hindi`;
    const url = `${YT_BASE}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YT_API_KEY}&videoCategoryId=10`;
    const data = await getJSON(url);
    const items = data.items || [];

    return items
      .filter((item) => {
        const t = (item.snippet?.title || "").toLowerCase();
        return t.includes("song") || t.includes("full video") || t.includes("lyrical");
      })
      .map((item) => {
        const ytId = item.id?.videoId || "";
        return {
          title: item.snippet?.title || "",
          ytId,
          url: `https://www.youtube.com/watch?v=${ytId}`,
          thumbnailUrl: item.snippet?.thumbnails?.medium?.url
            || `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`,
          singer: "",
          musicDirector: "",
          lyricist: "",
        };
      });
  } catch (err) {
    logger.warn("YouTube songs search failed", { title, year, err: err.message });
    return [];
  }
}

/**
 * Get YouTube thumbnail URL for a known ytId without API call.
 */
function ytThumbnail(ytId, quality = "hqdefault") {
  if (!ytId) return "";
  return `https://img.youtube.com/vi/${ytId}/${quality}.jpg`;
}

module.exports = { searchTrailer, searchSongs, ytThumbnail };
