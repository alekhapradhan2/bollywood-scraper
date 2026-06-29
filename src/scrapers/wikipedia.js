// ─────────────────────────────────────────────────────────────────────────────
//  scrapers/wikipedia.js — Wikipedia REST API for plot, cast, production details
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { getJSON, getHTML } = require("../utils/http");
const { htmlToPlain, cleanText } = require("../utils/normalizer");
const cheerio = require("cheerio");
const logger = require("../utils/logger");

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_REST = "https://en.wikipedia.org/api/rest_v1";

/**
 * Search Wikipedia for a movie article.
 * @returns {string|null} page title of best match
 */
async function searchWikipedia(movieTitle, year) {
  try {
    const query = `${movieTitle} ${year} film`;
    const url = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=5`;
    const data = await getJSON(url);
    const results = data.query?.search || [];

    // Pick the result that best matches our title+year
    for (const r of results) {
      const t = r.title.toLowerCase();
      const m = movieTitle.toLowerCase();
      if (t.includes(m) && (t.includes(String(year)) || t.includes("film"))) {
        return r.title;
      }
    }
    // Fallback: first result
    return results[0]?.title || null;
  } catch (err) {
    logger.warn("Wikipedia search failed", { movieTitle, year, err: err.message });
    return null;
  }
}

/**
 * Fetch Wikipedia page summary (intro + infobox).
 */
async function fetchPageSummary(pageTitle) {
  try {
    const url = `${WIKI_REST}/page/summary/${encodeURIComponent(pageTitle)}`;
    const data = await getJSON(url);
    return {
      extract: data.extract || "",
      extractHtml: data.extract_html || "",
      thumbnail: data.thumbnail?.source || "",
      pageId: data.pageid,
    };
  } catch (err) {
    logger.warn("Wikipedia fetchPageSummary failed", { pageTitle, err: err.message });
    return null;
  }
}

/**
 * Fetch full Wikipedia article HTML to parse infobox and cast table.
 */
async function fetchPageSections(pageTitle) {
  try {
    const url = `${WIKI_API}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text&format=json&origin=*`;
    const data = await getJSON(url);
    const html = data.parse?.text?.["*"] || "";
    return html;
  } catch (err) {
    logger.warn("Wikipedia fetchPageSections failed", { pageTitle, err: err.message });
    return "";
  }
}

/**
 * Parse Wikipedia infobox from raw HTML into key-value pairs.
 */
function parseInfobox(html) {
  const $ = cheerio.load(html);
  const info = {};

  $(".infobox.vevent tr, .infobox-film tr, .infobox tr").each((_, row) => {
    const label = $(row).find("th").text().trim().toLowerCase();
    const valueEl = $(row).find("td");
    if (!label || !valueEl.length) return;

    const value = cleanText(valueEl.text());
    if (value) info[label] = value;
  });

  return info;
}

/**
 * Extract plot section text from Wikipedia HTML.
 */
function parsePlot(html) {
  const $ = cheerio.load(html);

  // Find the Plot / Story / Storyline section
  let plot = "";
  $("h2, h3").each((_, el) => {
    const heading = $(el).text().toLowerCase().replace(/\[.*?\]/g, "").trim();
    if (heading === "plot" || heading === "story" || heading === "storyline") {
      let node = $(el).next();
      const parts = [];
      while (node.length && !node.is("h2")) {
        if (node.is("p")) parts.push(htmlToPlain(node.html()));
        node = node.next();
      }
      plot = parts.join("\n\n").trim();
      return false; // break each
    }
  });

  return plot;
}

/**
 * Full Wikipedia scrape for a movie.
 */
async function scrapeMovie(movieTitle, year) {
  const pageTitle = await searchWikipedia(movieTitle, year);
  if (!pageTitle) return null;

  const [summary, fullHtml] = await Promise.all([
    fetchPageSummary(pageTitle),
    fetchPageSections(pageTitle),
  ]);

  if (!summary && !fullHtml) return null;

  const infobox = fullHtml ? parseInfobox(fullHtml) : {};
  const plot = fullHtml ? parsePlot(fullHtml) : "";

  return {
    source: "wikipedia",
    pageTitle,
    extract: summary?.extract || "",
    plot,
    infobox,
    thumbnail: summary?.thumbnail || "",
    // Parse infobox fields
    director: infobox["directed by"] || infobox["director"] || "",
    producer: infobox["produced by"] || infobox["producer"] || infobox["producers"] || "",
    writer: infobox["written by"] || infobox["screenplay"] || infobox["story"] || "",
    music: infobox["music by"] || infobox["music"] || "",
    cinematography: infobox["cinematography"] || "",
    editing: infobox["edited by"] || infobox["editing"] || "",
    distributor: infobox["distributed by"] || infobox["distributor"] || "",
    releaseDate: infobox["release date"] || infobox["released"] || "",
    runtime: infobox["running time"] || infobox["runtime"] || "",
    country: infobox["country"] || "",
    language: infobox["language"] || infobox["languages"] || "",
    budget: infobox["budget"] || "",
    boxOffice: infobox["box office"] || "",
  };
}

module.exports = { scrapeMovie, searchWikipedia, fetchPageSummary };
