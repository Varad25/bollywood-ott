#!/usr/bin/env node
/**
 * Regenerates catalog-data.json from the Access Bollywood monitor snapshot.
 * Usage:
 *   node update-from-snapshot.js [path-to-snapshot.md]
 * The addon itself reads the snapshot live when it can find it; this script
 * is for running the addon anywhere else (it bundles a frozen copy).
 * To add newly alerted titles, append them to titles.json instead —
 * one object per alert: { "title": "<exactly as alerted>", "platform": "...", "alertDate": "YYYY-MM-DD" }
 */
const fs = require("fs");
const path = require("path");
const { parseSnapshot } = require("./addon");

const src =
  process.argv[2] ||
  process.env.SNAPSHOT_PATH ||
  "/home/hatch/workspace/goals/access-bollywood-amazon-prime-new-movies-monitor/hidden_files/snapshot.md";

const text = fs.readFileSync(src, "utf8");
const data = parseSnapshot(text);
const dest = path.join(__dirname, "catalog-data.json");
fs.writeFileSync(dest, JSON.stringify(data, null, 2));
const counts = Object.entries(data).map(([k, v]) => `${k}: ${v.titles.length} (updated ${v.listUpdated})`);
console.log(`Wrote ${dest}\n  ` + counts.join("\n  "));
