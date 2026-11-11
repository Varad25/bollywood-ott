#!/usr/bin/env node
/**
 * Access Bollywood — New Titles (Stremio addon)
 *
 * One catalog ("Access Bollywood — New Titles", declared once per type):
 * the titles the daily Access Bollywood monitor actually alerted on
 * (Hindi-first filter already applied). Titles are IMDb-matched at build
 * time (enrich.js, via Cinemeta) so metas carry real IMDb IDs + posters;
 * no streams — the user's own metadata/stream addons attach to the
 * IMDb-ID detail pages.
 *
 * Data sources, in priority order:
 *  1. The live snapshot.md from the daily monitor, if found
 *     (SNAPSHOT_PATH env, or the default goal path on Cosmo's VM).
 *     When the daily check updates the snapshot, the addon picks the
 *     new titles up on its next request — no rebuild needed.
 *  2. catalog-data.json bundled with the addon (generated from the
 *     snapshot by update-from-snapshot.js).
 * Alerts always come from titles.json (curated, append-only).
 *
 * Zero dependencies: run with plain Node 18+.
 *   node addon.js            # serves on PORT (default 7000)
 * Install in Stremio with:   http://127.0.0.1:7000/manifest.json
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 7000;
const DIR = __dirname;

const PLATFORMS = [
  { key: "netflix", name: "Netflix", snapshotHeading: "Netflix" },
  { key: "prime", name: "Amazon Prime", snapshotHeading: "Amazon Prime" },
  { key: "hulu", name: "Hulu", snapshotHeading: "Hulu" },
  { key: "zee5", name: "Zee5", snapshotHeading: "Zee5" },
];

// ---------- title parsing ----------
// Raw snapshot/alert strings look like:
//   "Dhindora, Season 1 (2021)"
//   "Love Always, Season 1 (2026/Tamil, Hindi-dubbed)*"
//   "Mirzapur: The Movie (2026)"
function parseRawTitle(raw, platformName, extra = {}) {
  let s = String(raw).trim().replace(/\*+$/, "").trim();
  let year = null;
  let language = null;
  const m = s.match(/\((\d{4})(?:\/([^)]*))?\)\s*$/);
  if (m) {
    year = m[1];
    language = m[2] || null;
    s = s.slice(0, m.index).trim();
  }
  let seasonNote = null;
  const sm = s.match(/,\s*(Seasons?\s+[^,]+)$/);
  let baseName = s;
  if (sm) {
    seasonNote = sm[1].trim();
    baseName = s.slice(0, sm.index).trim();
  }
  const isSeries = !!seasonNote;
  const slug =
    baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") +
    (year ? `-${year}` : "");
  const platformSlug = platformName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return {
    id: `ab:${platformSlug}:${slug}`,
    name: baseName,
    type: isSeries ? "series" : "movie",
    year,
    language,
    seasonNote,
    platform: platformName,
    alertDate: extra.alertDate || null,
    listUpdated: extra.listUpdated || null,
    raw: String(raw).trim(),
  };
}

// ---------- enrichment (IMDb IDs + posters, from enrich.js / Cinemeta) ----------
function loadEnrichCache() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, "enrich-cache.json"), "utf8"));
  } catch (_) {
    return {};
  }
}
const enrichKey = (t) => `${t.type}|${t.name.toLowerCase()}|${t.year || ""}`;
function enrichOf(t) {
  const e = loadEnrichCache()[enrichKey(t)];
  return e && e.imdbId ? e : null;
}

function toMeta(t) {
  const bits = [`New on ${t.platform}.`];
  if (t.seasonNote) bits.push(t.seasonNote + ".");
  if (t.language) bits.push(`Language: ${t.language}.`);
  if (t.alertDate) bits.push(`Alerted ${t.alertDate}.`);
  else if (t.source && t.releaseLabel) bits.push(`Released ${t.releaseLabel}.`);
  else if (t.listUpdated) bits.push(`List updated ${t.listUpdated}.`);
  bits.push(
    t.source
      ? `Source: ${t.source} (India OTT releases), via the daily monitor.`
      : "Source: Access Bollywood daily monitor."
  );
  const e = enrichOf(t);
  const meta = {
    // Prefer the real IMDb ID: the detail page then becomes the standard
    // Stremio page for the title, so installed metadata addons (e.g. AIO
    // Metadata) and stream addons attach to it automatically.
    id: e ? e.imdbId : t.id,
    type: t.type,
    name: t.name,
    releaseInfo: t.year || undefined,
    year: t.year || undefined,
    description: bits.join(" "),
    genres: e && e.genres && e.genres.length ? e.genres : ["Indian", t.platform],
  };
  if (e) {
    if (e.poster) meta.poster = e.poster;
    if (e.background) meta.background = e.background;
    if (e.imdbRating) meta.imdbRating = e.imdbRating;
    if (e.runtime) meta.runtime = e.runtime;
  }
  return meta;
}

// ---------- snapshot parsing ----------
function parseSnapshot(text) {
  const out = {}; // platformKey -> { listUpdated, titles: [parsed] }
  const sections = text.split(/^##\s+\d+\.\s+/m).slice(1);
  for (const sec of sections) {
    const heading = sec.split("\n")[0].trim();
    const platform = PLATFORMS.find((p) => p.snapshotHeading === heading);
    if (!platform) continue;
    const upd = sec.match(/List updated:\s*([A-Za-z]+ \d{1,2}, \d{4})/);
    const listUpdated = upd ? upd[1] : null;
    const na = sec.match(/Newly Added at capture[^\n]*:\s*\n\s+([^\n]+)/);
    let titles = [];
    if (na) {
      titles = na[1]
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean)
        // Hulu entries carry a long "and its ...-dubbed versions" tail; keep the head title only
        .map((x) => x.replace(/\s+and its .*$/i, "").trim())
        .map((x) => parseRawTitle(x, platform.name, { listUpdated }));
    }
    out[platform.key] = { listUpdated, titles };
  }
  return out;
}

function loadPlatformData() {
  const candidates = [
    process.env.SNAPSHOT_PATH,
    "/home/hatch/workspace/goals/access-bollywood-amazon-prime-new-movies-monitor/hidden_files/snapshot.md",
    path.join(DIR, "snapshot.md"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, "utf8");
      const parsed = parseSnapshot(text);
      if (Object.keys(parsed).length) return parsed;
    } catch (_) {}
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, "catalog-data.json"), "utf8"));
  } catch (_) {
    return {};
  }
}

function loadAlerts() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, "titles.json"), "utf8"));
    return raw.map((r) => parseRawTitle(r.title, r.platform, { alertDate: r.alertDate }));
  } catch (_) {
    return [];
  }
}

// Baseline titles from the monitor's two additional sources (Cinebuds +
// OTTweek, added 2026-11-06): India-OTT releases incl. platforms Access
// Bollywood doesn't track (SonyLIV, JioHotstar, …). Static capture in
// other-baseline.json; new finds from those sources arrive via titles.json.
function loadOtherBaseline() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, "other-baseline.json"), "utf8"));
    return raw.map((r) => {
      const d = new Date(`${r.date}T12:00:00Z`);
      const nice = Number.isNaN(d.getTime())
        ? null
        : d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
      const t = parseRawTitle(r.year ? `${r.title} (${r.year})` : r.title, r.platform, { listUpdated: nice });
      if (r.type) t.type = r.type;
      if (r.language) t.language = r.language;
      t.source = r.source || "India OTT";
      t.releaseLabel = nice;
      return t;
    });
  } catch (_) {
    return [];
  }
}

// ---------- catalogs ----------
// Titles the user asked to keep out of the catalog (2026-11-06):
// all Chhota Bheem entries, incl. spin-offs. Applies to the advertised
// catalogs only; the underlying data and chat alerts are untouched.
const CATALOG_BLOCKLIST = [/^chhota bheem\b/i];
const catalogBlocked = (t) => CATALOG_BLOCKLIST.some((re) => re.test(t.name));

// IMDb-only catalogs (user request, 2026-11-07): a title appears in a
// catalog only when build-time enrichment found an IMDb ID for it.
// Without one, its detail page is a dead-end custom ab: page that the
// user's metadata/stream addons cannot attach to. The underlying data
// (titles.json, catalog-data.json, other-baseline.json) is untouched —
// a title that gains an IMDb match in a later build re-enters the
// catalog automatically.
const hasImdbId = (t) => !!enrichOf(t);

function buildCatalogs() {
  // One catalog only (user request, 2026-11-06): alerted titles merged with
  // all four platforms' Newly Added lists. Stremio separates Movies and
  // Series into different Discover tabs, so the single catalog is declared
  // once per type under the same name — one row in each tab.
  return [
    { type: "movie", id: "ab-new-movie", name: "Access Bollywood — New Titles" },
    { type: "series", id: "ab-new-series", name: "Access Bollywood — New Titles" },
  ];
}

function catalogMetas(catalogId, type, search) {
  let titles = [];
  if (catalogId.startsWith("ab-new")) {
    // The single catalog (user request, 2026-11-06): alerted titles first,
    // then every platform's current Newly Added list, de-duped by meta id.
    titles = allTitles().filter((t) => t.type === type && !catalogBlocked(t));
  } else if (catalogId.startsWith("ab-alerts")) {
    titles = loadAlerts().filter((t) => t.type === type && !catalogBlocked(t));
  } else {
    const m = catalogId.match(/^ab-(netflix|prime|hulu|zee5)-(movie|series)$/);
    if (!m) return [];
    const data = loadPlatformData();
    titles = ((data[m[1]] && data[m[1]].titles) || []).filter((t) => t.type === type);
  }
  if (catalogId.startsWith("ab-new") || catalogId.startsWith("ab-alerts")) {
    // Newest first: alerted titles by alert date (latest alert first),
    // then the baseline Newly Added titles by their list's updated date,
    // keeping each list's on-page order (Access Bollywood lists newest
    // additions first within a list).
    titles = titles
      .map((t, i) => ({ t, i }))
      .sort((a, b) => {
        const ad = a.t.alertDate, bd = b.t.alertDate;
        if (ad && bd) return bd.localeCompare(ad) || b.i - a.i;
        if (ad) return -1;
        if (bd) return 1;
        const au = Date.parse(a.t.listUpdated || "") || 0;
        const bu = Date.parse(b.t.listUpdated || "") || 0;
        return bu - au || a.i - b.i;
      })
      .map((x) => x.t);
  }
  // IMDb-only: drop every title enrichment could not match to an IMDb ID.
  titles = titles.filter(hasImdbId);
  if (search) {
    const q = search.toLowerCase();
    titles = titles.filter((t) => t.name.toLowerCase().includes(q));
  }
  // de-dupe by final meta id (an IMDb-matched title alerted on two
  // platforms collapses to one entry), keep first occurrence. The merged
  // catalogs additionally de-dupe by name+type, so the same title arriving
  // from two sources (Access Bollywood vs Cinebuds/OTTweek) without an
  // IMDb match still shows only once.
  const seen = new Set();
  const seenName = new Set();
  const dedupeByName = catalogId.startsWith("ab-new") || catalogId.startsWith("ab-alerts");
  return titles.map(toMeta).filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    if (dedupeByName) {
      const nk = `${m.type}|${m.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
      if (seenName.has(nk)) return false;
      seenName.add(nk);
    }
    return true;
  });
}

function allTitles() {
  const all = [...loadAlerts()];
  const data = loadPlatformData();
  for (const k of Object.keys(data)) all.push(...(data[k].titles || []));
  all.push(...loadOtherBaseline());
  return all;
}

function findTitle(type, id) {
  const all = allTitles();
  return (
    all.find((x) => (x.id === id || (enrichOf(x) || {}).imdbId === id) && x.type === type) ||
    all.find((x) => x.id === id || (enrichOf(x) || {}).imdbId === id) ||
    null
  );
}

function findMeta(type, id) {
  const t = findTitle(type, id);
  return t ? toMeta(t) : null;
}

// No stream resource (user decision, 2026-11-06: posters + IMDb IDs only,
// no "Watch on …" links). Playback addons the user installs attach to the
// IMDb-ID detail pages themselves.

// ---------- manifest ----------
const manifest = {
  id: "community.accessbollywood.newtitles",
  version: "1.4.0",
  name: "Access Bollywood — New Titles",
  description:
    "New Indian movies & series on Netflix, Amazon Prime, Hulu, Zee5 and India OTT (SonyLIV, JioHotstar, …), from the daily monitor (Access Bollywood + Cinebuds + OTTweek, Hindi-first). IMDb-matched, with posters.",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  idPrefixes: ["ab:", "tt"],
  catalogs: buildCatalogs(),
  behaviorHints: { configurable: false },
  stremioAddonsConfig: {
    issuer: "https://stremio-addons.net",
    signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..ctq-Jk-BVj7u6yowLQ7txQ.tJWr7edo9-Y6CKRAUA9MhyBHZfyxU_OXaGwyot6bniHyGGOgQE1Pz9HeQ5poRJsAlCDBUkv2MzRQYshSE_1kK50ILbfl8BjF5LrJAlrvhWdbAKQ3s67PghqK4F-DsFu2.wJ-DMXCPaX788NJrpn2_3Q",
  },
};

// ---------- server ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "max-age=300",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (url.pathname === "/" || url.pathname === "/manifest.json") {
      return send(res, 200, manifest);
    }
    // /catalog/:type/:id.json  or  /catalog/:type/:id/:extra.json
    if (parts[0] === "catalog" && parts.length >= 3) {
      const type = parts[1];
      const id = parts[2].replace(/\.json$/, "");
      let search = null;
      if (parts[3]) {
        const extraStr = parts[3].replace(/\.json$/, "");
        for (const pair of extraStr.split("&")) {
          const [k, v] = pair.split("=");
          if (k === "search") search = decodeURIComponent(v || "");
          if (k === "skip") {
            // single-page catalogs; skip beyond 0 returns empty
            if (parseInt(v, 10) > 0) return send(res, 200, { metas: [] });
          }
        }
      }
      return send(res, 200, { metas: catalogMetas(id, type, search) });
    }
    // /meta/:type/:id.json
    if (parts[0] === "meta" && parts.length >= 3) {
      const meta = findMeta(parts[1], parts[2].replace(/\.json$/, ""));
      return meta ? send(res, 200, { meta }) : send(res, 404, { error: "not found" });
    }
    // /stream/... — no streams from this addon
    if (parts[0] === "stream") {
      return send(res, 200, { streams: [] });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Access Bollywood addon listening on http://127.0.0.1:${PORT}/manifest.json`);
  });
}

module.exports = { parseRawTitle, parseSnapshot, catalogMetas, manifest, findMeta, loadOtherBaseline };
