require("dotenv").config();
const axios    = require("axios");
const mongoose = require("mongoose");

const MovieSchema = new mongoose.Schema({ title: String, imdbId: String }, { strict: false, collection: "movies" });
const Movie = mongoose.model("Movie", MovieSchema);

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { dbName: "test" });
  const movies = await Movie.find(
    { imdbId: { $regex: "^tt" } },
    "title imdbId"
  ).limit(80).lean();
  await mongoose.disconnect();

  console.log(`Scanning ${movies.length} movies for India OTT providers...`);
  const seen = {};

  for (const m of movies) {
    try {
      const find = await axios.get("https://api.themoviedb.org/3/find/" + m.imdbId, {
        params: { api_key: process.env.TMDB_API_KEY, external_source: "imdb_id" },
        timeout: 8000
      });
      const tmdbId = find.data.movie_results?.[0]?.id;
      if (!tmdbId) continue;

      const wp = await axios.get("https://api.themoviedb.org/3/movie/" + tmdbId + "/watch/providers", {
        params: { api_key: process.env.TMDB_API_KEY },
        timeout: 8000
      });
      const india = wp.data.results?.IN;
      if (!india) continue;

      ["flatrate", "subscription", "free", "ads", "rent", "buy"].forEach(tier => {
        (india[tier] || []).forEach(p => {
          if (!seen[p.provider_id]) seen[p.provider_id] = p.provider_name;
        });
      });
      await new Promise(r => setTimeout(r, 250));
    } catch(_) {}
  }

  console.log("\n=== ALL INDIA OTT PROVIDER IDs FOUND ===");
  Object.entries(seen)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([id, name]) => console.log(`  ${id}: ${name}`));
}

main().catch(console.error);
