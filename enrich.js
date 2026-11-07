#!/usr/bin/env node
/**
 * Enriches titles with IMDb IDs + poster art from Cinemeta (Stremio's own
 * IMDb-backed metadata addon — free, no API key).
 *
 * For every unique title known to the addon (alerts in titles.json +
 * per-platform titles in catalog-data.json) it searches Cinemeta by name,
 * accepts a candidate only when the normalized name matches exactly and
 * the year is within 1, then stores { imdbId, poster, background,
 * imdbRating, genres, runtime, videos } in enrich-cache.json.
 *
 * With an IMDb ID, a title's Stremio detail page is the standard one:
 * the user's installed metadata addons (e.g. AIO Metadata) and stream
 * addons can attach to it. The poster is also embedded in our own
 * catalog responses so Discover rows show art immediately.
 *
 * Cached results (including misses, as { imdbId: null }) are not
 * re-queried; run with --force to redo everything.
 *
 * Usage: node enrich.js [--force]   (part of `npm run build`)
 */
const fs = require("fs");
const path = require("path");
const { parseRawTitle, loadOtherBaseline } = require("./addon");

const DIR = __dirname;
const CACHE_PATH = path.join(DIR, "enrich-cache.json");
const CINEMETA = "https://v3-cinemeta.strem.io";
const FORCE = process.argv.includes("--force");

const keyOf = (t) => `${t.type}|${t.name.toLowerCase()}|${t.year || ""}`;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function collectTitles() {
  const out = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, "titles.json"), "utf8"));
    for (const r of raw) {
      const t = parseRawTitle(r.title, r.platform, {});
      out.set(keyOf(t), t);
    }
  } catch (_) {}
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DIR, "catalog-data.json"), "utf8"));
    for (const k of Object.keys(data)) {
      for (const t of data[k].titles || []) out.set(keyOf(t), t);
    }
  } catch (_) {}
  for (const t of loadOtherBaseline()) out.set(keyOf(t), t);
  return [...out.values()];
}

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "access-bollywood-addon/1.2" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Manual fixes where Cinemeta/IMDb uses a different title
// (key format: type|lowercased name|year).
const OVERRIDES = {
  "movie|manmarziyaan|2018": "tt5474036", // Cinemeta lists it as "Husband Material"
};

async function enrichOne(t) {
  const override = OVERRIDES[keyOf(t)];
  if (override) {
    const full = await getJson(`${CINEMETA}/meta/${t.type}/${override}.json`);
    const meta = full.meta || {};
    return {
      imdbId: override,
      poster: meta.poster || null,
      background: meta.background || null,
      imdbRating: meta.imdbRating || null,
      genres: meta.genres || null,
      runtime: meta.runtime || null,
      videos: (meta.videos || [])
        .map((v) => ({ id: v.id, season: v.season, episode: v.episode }))
        .slice(0, 500),
    };
  }
  const q = encodeURIComponent(t.name);
  const search = await getJson(`${CINEMETA}/catalog/${t.type}/top/search=${q}.json`);
  const metas = search.metas || [];
  const wantYear = t.year ? parseInt(t.year, 10) : null;
  const candidates = metas
    .filter((m) => norm(m.name) === norm(t.name))
    .map((m) => {
      const y = parseInt(String(m.releaseInfo || "").slice(0, 4), 10);
      return { m, yearDiff: wantYear && Number.isFinite(y) ? Math.abs(y - wantYear) : 99 };
    })
    // Movies: our year is the release year, require it within 1.
    // Series: our year is the alerted season's year while Cinemeta's is
    // the show's start year, so accept any year, closest first.
    .filter((c) => t.type === "series" || !wantYear || c.yearDiff <= 1)
    .sort((a, b) => a.yearDiff - b.yearDiff);
  if (!candidates.length) return { imdbId: null };
  const best = candidates[0].m;
  const full = await getJson(`${CINEMETA}/meta/${t.type}/${best.id}.json`);
  const meta = full.meta || {};
  return {
    imdbId: best.id,
    poster: meta.poster || best.poster || null,
    background: meta.background || null,
    imdbRating: meta.imdbRating || null,
    genres: meta.genres || null,
    runtime: meta.runtime || null,
    videos: (meta.videos || [])
      .map((v) => ({ id: v.id, season: v.season, episode: v.episode }))
      .slice(0, 500),
  };
}

(async () => {
  let cache = {};
  if (!FORCE) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); } catch (_) {}
  }
  const titles = collectTitles();
  let matched = 0, missed = 0, skipped = 0;
  for (const t of titles) {
    const key = keyOf(t);
    if (cache[key]) { skipped++; if (cache[key].imdbId) matched++; else missed++; continue; }
    try {
      cache[key] = await enrichOne(t);
    } catch (e) {
      cache[key] = { imdbId: null, error: String(e.message || e) };
    }
    if (cache[key].imdbId) { matched++; console.log(`  ✓ ${t.name} (${t.year || "?"}) → ${cache[key].imdbId}`); }
    else { missed++; console.log(`  ✗ ${t.name} (${t.year || "?"}) — no Cinemeta match`); }
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
    await sleep(120);
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  console.log(`Enrichment: ${matched} matched, ${missed} unmatched, ${skipped} cached (${titles.length} titles)`);
})().catch((e) => { console.error("enrich failed:", e); process.exit(1); });
