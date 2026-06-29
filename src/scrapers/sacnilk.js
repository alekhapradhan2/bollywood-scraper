// ─────────────────────────────────────────────────────────────────────────────
//  scrapers/sacnilk.js — Day-wise box office (India net collections)
//  Sacnilk is one of the most reliable sources for Hindi box office.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const cheerio = require("cheerio");
const { getHTML } = require("../utils/http");
const { cleanText, parseCurrencyToINR, formatINR } = require("../utils/normalizer");
const logger = require("../utils/logger");

const BASE = "https://sacnilk.com";

/**
 * Build the Sacnilk movie URL from title and year.
 * Sacnilk uses slugs like: /movie/abc-xyz-2024-box-office-collection
 */
function buildUrl(title, year) {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
  return `${BASE}/movie/${slug}-${year}-box-office-collection`;
}

/**
 * Scrape Sacnilk movie box office page.
 * Returns day-wise collection array.
 */
async function scrapeDailyBoxOffice(title, year) {
  const url = buildUrl(title, year);
  try {
    const html = await getHTML(url);
    const $ = cheerio.load(html);
    const days = [];

    // Sacnilk table structure: Day | Date | Net Collection | Total
    $("table tr").each((i, row) => {
      if (i === 0) return; // skip header
      const cells = $(row).find("td");
      if (cells.length < 3) return;

      const dayText = cleanText($(cells[0]).text());
      const dateText = cleanText($(cells[1]).text());
      const netText = cleanText($(cells[2]).text());

      // Day text may be "Day 1", "1", etc.
      const dayNum = parseInt(dayText.replace(/\D/g, ""));
      if (isNaN(dayNum) || dayNum <= 0) return;

      const net = parseCurrencyToINR(netText);
      if (!net) return;

      const gross = Math.round(net * 1.18);

      days.push({
        day: dayNum,
        net: formatINR(net),
        gross: formatINR(gross),
        date: dateText || "",
        note: "",
        _rawNet: net,
      });
    });

    return days;
  } catch (err) {
    logger.warn("Sacnilk scrape failed", { title, year, url, err: err.message });
    return [];
  }
}

/**
 * Scrape summary box office (opening, week 1, total) from Sacnilk.
 */
async function scrapeBoxOfficeSummary(title, year) {
  const url = buildUrl(title, year);
  try {
    const html = await getHTML(url);
    const $ = cheerio.load(html);
    const summary = { opening: "TBA", firstWeek: "TBA", total: "TBA" };

    // Try to find summary cards or table rows
    $("table tr, .collection-row").each((_, row) => {
      const text = cleanText($(row).text()).toLowerCase();
      const valEl = $(row).find("td").last();
      const val = cleanText(valEl.text());

      if (!val) return;
      if (text.includes("day 1") || text.includes("opening")) summary.opening = val;
      else if (text.includes("week 1") || text.includes("first week")) summary.firstWeek = val;
      else if (text.includes("total") || text.includes("lifetime")) summary.total = val;
    });

    return summary;
  } catch {
    return null;
  }
}

module.exports = { scrapeDailyBoxOffice, scrapeBoxOfficeSummary, buildUrl };
