require("dotenv").config();
const mongoose = require("mongoose");

// Configuration
const MONGO_URI = process.env.MONGO_URI;
const DRY_RUN = !process.argv.includes("--confirm");

// Minimal schemas
const MovieSchema = new mongoose.Schema(
  {
    title: String,
    releaseDate: String,
  },
  { strict: false, collection: "movies" }
);
const Movie = mongoose.models.Movie || mongoose.model("Movie", MovieSchema);

const BlogSchema = new mongoose.Schema(
  {
    title: String,
    movieId: { type: mongoose.Schema.Types.ObjectId, ref: "Movie" },
  },
  { strict: false, collection: "blogs" }
);
const Blog = mongoose.models.Blog || mongoose.model("Blog", BlogSchema);

async function main() {
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI not set in .env");
    process.exit(1);
  }

  console.log("📡 Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected\n");

  console.log("🔍 Searching for movies released before 2020...");
  
  // Regex to match years 1900-2019 safely. This ignores "TBA", null, and 2020+
  const query = { releaseDate: { $regex: /^(19\d{2}|200\d|201\d)/ } };
  
  const oldMovies = await Movie.find(query, "_id title releaseDate").lean();
  
  if (oldMovies.length === 0) {
    console.log("✨ No movies found released before 2020.");
    await mongoose.disconnect();
    return;
  }
  
  console.log(`📋 Found ${oldMovies.length} movies released before 2020.`);
  
  const movieIds = oldMovies.map((m) => m._id);
  
  console.log("\n🔍 Searching for blogs associated with these old movies...");
  
  const blogsToDelete = await Blog.find({ movieId: { $in: movieIds } }, "_id title movieId").lean();
  
  if (blogsToDelete.length === 0) {
    console.log("✨ No blogs found for the pre-2020 movies. Nothing to do.");
    await mongoose.disconnect();
    return;
  }
  
  console.log(`📋 Found ${blogsToDelete.length} blogs to delete.\n`);
  
  // Show a sample of what will be deleted
  const sampleSize = Math.min(blogsToDelete.length, 10);
  console.log(`--- Sample of ${sampleSize} blogs to be deleted ---`);
  for (let i = 0; i < sampleSize; i++) {
    const blog = blogsToDelete[i];
    const movie = oldMovies.find((m) => m._id.toString() === blog.movieId.toString());
    console.log(`- Blog: "${blog.title}"`);
    console.log(`  (Linked to Movie: "${movie ? movie.title : 'Unknown'}", Released: ${movie ? movie.releaseDate : 'Unknown'})`);
  }
  console.log("----------------------------------------------\n");

  if (DRY_RUN) {
    console.log("🛑 DRY RUN MODE");
    console.log(`To actually delete these ${blogsToDelete.length} blogs, run the script with the --confirm flag.`);
    console.log("Example: node delete-old-blogs.js --confirm");
  } else {
    console.log("🔥 CONFIRM FLAG DETECTED. Executing deletion...");
    const result = await Blog.deleteMany({ movieId: { $in: movieIds } });
    console.log(`✅ Successfully deleted ${result.deletedCount} blogs.`);
  }

  await mongoose.disconnect();
  console.log("\n✅ Done!");
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
