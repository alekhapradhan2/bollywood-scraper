require("dotenv").config();
const mongoose = require("mongoose");
mongoose.connect(process.env.MONGO_URI, { dbName: "test" }).then(async () => {
  const db = mongoose.connection.db;
  const docs = await db.collection("movies").find({ languages: { $exists: true, $not: { $size: 0 } } }).limit(2).toArray();
  console.log("Docs with languages:", docs.map(d => ({ title: d.title, languages: d.languages, language: d.language })));
  process.exit(0);
});
