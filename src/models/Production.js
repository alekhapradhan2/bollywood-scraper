// ─────────────────────────────────────────────────────────────────────────────
//  models/Production.js — Minimal Production model stub
//  Only used if mongoose.models.Production hasn't been registered yet.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const mongoose = require("mongoose");

const ProductionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  logo: { type: String, default: "" },
  banner: { type: String, default: "" },
  bio: { type: String, default: "" },
  founded: { type: String, default: "" },
  website: { type: String, default: "" },
  location: { type: String, default: "" },
}, { timestamps: true });

module.exports = mongoose.models.Production
  || mongoose.model("Production", ProductionSchema);
