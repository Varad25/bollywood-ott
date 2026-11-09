#!/usr/bin/env node
/**
 * Exports the addon as static JSON files for GitHub Pages (folder: docs/).
 *
 * Stremio addons are plain HTTPS GETs of JSON, so the catalog/meta side
 * works fully static:
 *   docs/manifest.json
 *   docs/catalog/<type>/<catalogId>.json
 *   docs/meta/<type>/<id>.json
 *   docs/stream/<type>/<id>.json   (empty streams — no stream resource)
 *
 * Limits vs. the live server: no in-catalog search, and no pagination
 * extras — fine here, the largest catalog is well under 100 entries.
 *
 * Usage: node export-static.js   (run after update-from-snapshot.js,
 * or just `npm run build` which does both)
 */
const fs = require("fs");
const path = require("path");
const { manifest, catalogMetas } = require("./addon");

const OUT = path.join(__dirname, "docs");

function writeJson(rel, obj) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(obj));
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

// manifest (GitHub Pages serves it at /<repo>/manifest.json)
writeJson("manifest.json", manifest);

fs.copyFileSync(path.join(__dirname, "landing-page.html"), path.join(OUT, "index.html"));

let metaCount = 0;
const seenMeta = new Set();
function writeMeta(m) {
  const key = `${m.type}/${m.id}`;
  if (seenMeta.has(key)) return;
  seenMeta.add(key);
  writeJson(path.join("meta", m.type, `${m.id}.json`), { meta: m });
  writeJson(path.join("stream", m.type, `${m.id}.json`), { streams: [] });
  metaCount++;
}
for (const cat of manifest.catalogs) {
  const metas = catalogMetas(cat.id, cat.type);
  writeJson(path.join("catalog", cat.type, `${cat.id}.json`), { metas });
  metas.forEach(writeMeta);
}
// Also export meta/stream JSON for every other title the server knows
// (per-platform lists), so detail pages resolve even though those
// catalogs are no longer advertised in the manifest.
const legacyCatalogs = [
  ["ab-alerts-movie", "movie"], ["ab-alerts-series", "series"],
  ["ab-netflix-movie", "movie"], ["ab-netflix-series", "series"],
  ["ab-prime-movie", "movie"], ["ab-prime-series", "series"],
  ["ab-hulu-movie", "movie"], ["ab-hulu-series", "series"],
  ["ab-zee5-movie", "movie"],
];
for (const [id, type] of legacyCatalogs) catalogMetas(id, type).forEach(writeMeta);
console.log(`Static export written to ${OUT}: ${manifest.catalogs.length} catalogs, ${metaCount} metas`);
