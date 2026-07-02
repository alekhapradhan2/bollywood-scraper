#!/usr/bin/env node
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const tmdb = require("./src/scrapers/tmdb");

const MONGO_URI = process.env.MONGO_URI;

const MovieSchema = new mongoose.Schema({
  title: String,
  releaseDate: String,
  languages: [{ type: String }],
}, { strict: false, collection: "movies" });

const Movie = mongoose.models.Movie || mongoose.model("Movie", MovieSchema);

let processed = 0, updated = 0, skipped = 0, failed = 0;

function printProgress(total) {
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  process.stdout.write(
    `\r  Progress: ${processed}/${total} (${pct}%) | ✅ Updated: ${updated} | ⏭ Skipped: ${skipped} | ❌ Failed: ${failed}   `
  );
}

async function processMovie(movie, total) {
  try {
    const year = movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : null;
    
    // 1. Search for the movie by title and year
    const searchResults = await tmdb.searchMovie(movie.title, year);
    if (!searchResults || searchResults.length === 0) {
      skipped++;
      processed++;
      printProgress(total);
      return;
    }

    const tmdbId = searchResults[0].id;

    // 2. Fetch full details using the tmdbId
    const details = await tmdb.fetchMovieDetails(tmdbId);
    if (!details || !details.spoken_languages || details.spoken_languages.length === 0) {
      skipped++;
    } else {
      const languages = details.spoken_languages.map(l => l.english_name);
      
      // Update the DB with the full languages array AND the tmdbId so we have it for the future
      await Movie.findByIdAndUpdate(movie._id, { 
        $set: { 
          languages: languages,
          tmdbId: String(tmdbId) 
        } 
      });
      updated++;
    }
  } catch (err) {
    failed++;
  }
  processed++;
  printProgress(total);
}

async function main() {
  console.log("🎬 Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI, { dbName: "test" });
  console.log("✅ Connected\n");

  const query = {
    $or: [
      { languages: { $exists: false } },
      { languages: { $size: 0 } },
    ]
  };

  const movies = await Movie.find(query, "title releaseDate").lean();
  const total = movies.length;

  if (total === 0) {
    console.log("✨ All movies already have their languages updated!");
    await mongoose.disconnect();
    return;
  }

  console.log(`📋 Found ${total} movie(s) missing languages. Starting update...`);

  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(3); // Safely handle TMDB rate limits

  await Promise.all(movies.map(m => limit(() => processMovie(m, total))));

  console.log("\n\n✅ Done! Summary:");
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed:  ${failed}\n`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error("\n❌ Fatal error:", err);
  process.exit(1);
});
