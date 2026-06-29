// ─────────────────────────────────────────────────────────────────────────────
//  scrapers/bollywoodhungama.js — Box office, cast, and additional metadata
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const cheerio = require("cheerio");
const { getHTML } = require("../utils/http");
const { cleanText, parseCurrencyToINR, formatINR } = require("../utils/normalizer");
const logger = require("../utils/logger");

const BASE = "https://www.bollywoodhungama.com";

/**
 * Search Bollywood Hungama for a movie.
 */
async function searchMovie(title, year) {
  try {
    const url = `${BASE}/movies/${encodeURIComponent(
      title.toLowerCase().replace(/\s+/g, "-")
    )}-${year}/`;
    const html = await getHTML(url);
    return { url, html };
  } catch {
    return null;
  }
}

/**
 * Scrape box office collection data from Bollywood Hungama movie page.
 */
async function scrapeBoxOffice(title, year) {
  const result = await searchMovie(title, year);
  if (!result) return null;

  try {
    const $ = cheerio.load(result.html);
    const data = {
      source: "bollywood_hungama",
      url: result.url,
      boxOffice: {},
      cast: [],
      director: "",
      synopsis: "",
      genres: [],
      runtime: "",
      budget: "",
    };

    // ── Synopsis
    const synopsis = $(".film-synopsis, .movie-synopsis, .synopsis").text().trim();
    if (synopsis) data.synopsis = cleanText(synopsis);

    // ── Box office table
    $("table tr, .box-office-table tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length >= 2) {
        const label = cleanText($(cells[0]).text()).toLowerCase();
        const value = cleanText($(cells[1]).text());
        if (label.includes("opening") || label.includes("1st day")) {
          data.boxOffice.opening = value;
        } else if (label.includes("week 1") || label.includes("first week")) {
          data.boxOffice.firstWeek = value;
        } else if (label.includes("total") || label.includes("lifetime")) {
          data.boxOffice.total = value;
        } else if (label.includes("budget")) {
          data.budget = value;
        }
      }
    });

    // ── Cast list
    $(".star-cast li, .cast-list li, .cast li").each((_, el) => {
      const name = cleanText($(el).find("a, span").first().text());
      const role = cleanText($(el).find(".char, .character, small").text());
      if (name) data.cast.push({ name, role: role || "", type: "Actor" });
    });

    // ── Director
    const dirText = $(".director, [itemprop='director']").text().trim();
    if (dirText) data.director = cleanText(dirText);

    return data;
  } catch (err) {
    logger.warn("BollywoodHungama scrape failed", { title, year, err: err.message });
    return null;
  }
}

/**
 * Scrape day-wise box office from Bollywood Hungama (if available).
 * Returns array of { day, net, gross, date }
 */
async function scrapeDailyBoxOffice(title, year) {
  try {
    const slug = title.toLowerCase().replace(/\s+/g, "-");
    const url = `${BASE}/movies/${slug}-${year}/box-office/`;
    const html = await getHTML(url);
    const $ = cheerio.load(html);

    const days = [];
    $("table tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 2) return;
      const dayText = cleanText($(cells[0]).text());
      const netText = cleanText($(cells[1]).text());
      const dayNum = parseInt(dayText.replace(/\D/g, ""));
      if (!isNaN(dayNum) && dayNum > 0 && netText) {
        const net = parseCurrencyToINR(netText);
        const gross = Math.round(net * 1.18); // ~18% GST
        days.push({
          day: dayNum,
          net: formatINR(net),
          gross: formatINR(gross),
          date: "",
          note: "",
        });
      }
    });

    return days;
  } catch {
    return [];
  }
}

module.exports = { scrapeBoxOffice, scrapeDailyBoxOffice };
