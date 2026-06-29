// ─────────────────────────────────────────────────────────────────────────────
//  logger.js — Winston-based structured logger
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { createLogger, format, transports } = require("winston");
const path = require("path");
const fs = require("fs");
const { LOG_DIR } = require("../config");

// Ensure log directory exists
const logDir = path.resolve(__dirname, "../../", LOG_DIR);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    // Console — human-readable
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const extras = Object.keys(meta).length
            ? " " + JSON.stringify(meta)
            : "";
          return `[${timestamp}] ${level}: ${message}${extras}`;
        })
      ),
    }),
    // Combined log file
    new transports.File({
      filename: path.join(logDir, "scraper.log"),
      maxsize: 10 * 1024 * 1024, // 10 MB rotate
      maxFiles: 5,
    }),
    // Error-only file
    new transports.File({
      filename: path.join(logDir, "errors.log"),
      level: "error",
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

module.exports = logger;
