#!/usr/bin/env node
/**
 * build-alpr-snapshot.mjs — regenerate the bundled worldwide ALPR camera pack.
 *
 * Pulls every OSM feature tagged `surveillance:type=ALPR` (the DeFlock
 * community's tagging schema) through one long-budget Overpass query,
 * normalizes it, and writes the compact pack the layer's ambient tier renders
 * at globe zoom:
 *
 *   src/data/local_data/alpr/cameras.json   (encodeAlprPack format)
 *   src/data/local_data/alpr/README.md      (provenance: date, mirror, query,
 *                                            counts, transform, ODbL notice)
 *
 * Deterministic transform (recorded in the README):
 *   - node/way/relation accepted; ways/relations use their Overpass `center`.
 *   - kept tags: manufacturer (brand as fallback), operator,
 *     direction (camera:direction as fallback, parsed to degrees).
 *   - privacy: any kept value containing an email or phone-like identifier is
 *     dropped (same public-release rule as the datacenters/dams snapshots);
 *     values are trimmed and capped at 80 chars.
 *   - coordinates rounded to 5 decimals (~1.1 m); rows sorted by OSM id.
 *
 * Run:  node scripts/build-alpr-snapshot.mjs
 *       node scripts/build-alpr-snapshot.mjs --from-file /tmp/alpr-world.json
 *       node scripts/build-alpr-snapshot.mjs --mirror https://overpass.example/api/interpreter
 *
 * The single worldwide query costs the mirror real work (~2-3 min server
 * time). Run this occasionally (the mapped fleet grows daily but the layer's
 * live tier already covers freshness at close zoom), not in CI.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCameraDirections } from '../src/data/alprData.js';
import { encodeAlprPack } from '../src/data/alprPack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR_DEFAULT = path.join(REPO_ROOT, 'src', 'data', 'local_data', 'alpr');

const QUERY = '[out:json][timeout:600][maxsize:1073741824];nwr["surveillance:type"="ALPR"];out center qt;';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const MIRROR = getOpt('--mirror', 'https://overpass-api.de/api/interpreter');
const FROM_FILE = getOpt('--from-file', null);
const OUT_DIR = getOpt('--out', OUT_DIR_DEFAULT);

const MAX_VALUE_CHARS = 80;
const EMAIL_RE = /@/;
const PHONE_RE = /\+?\d[\d\s().\-/]{7,}\d/;

/** Public-release tag value: trimmed, bounded, contact identifiers dropped. */
export function sanitizePackValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (EMAIL_RE.test(text) || PHONE_RE.test(text)) return null;
  return text.slice(0, MAX_VALUE_CHARS);
}

/** Overpass elements -> encodeAlprPack records, with a dropped-row count. */
export function normalizeSnapshotElements(elements) {
  const records = [];
  const seen = new Set();
  let droppedCount = 0;
  for (const element of Array.isArray(elements) ? elements : []) {
    const type = String(element?.type || '');
    const osmId = Number(element?.id);
    const latitude = Number(element?.lat ?? element?.center?.lat);
    const longitude = Number(element?.lon ?? element?.center?.lon);
    const key = `${type}:${osmId}`;
    if (!['node', 'way', 'relation'].includes(type) || !Number.isSafeInteger(osmId)
      || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || seen.has(key)) {
      droppedCount += 1;
      continue;
    }
    seen.add(key);
    const tags = element?.tags || {};
    records.push({
      osmType: type,
      osmId,
      latitude,
      longitude,
      manufacturer: sanitizePackValue(tags.manufacturer) || sanitizePackValue(tags.brand),
      operator: sanitizePackValue(tags.operator),
      directionsDeg: parseCameraDirections(tags.direction ?? tags['camera:direction']),
    });
  }
  return { records, droppedCount };
}

async function download() {
  console.log(`Querying ${MIRROR} (this legitimately takes minutes)...`);
  const response = await fetch(MIRROR, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'argus-alpr-snapshot/1.0 (one-off bundled-data refresh)',
    },
    body: `data=${encodeURIComponent(QUERY)}`,
  });
  if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
  const body = await response.text();
  const tempPath = path.join(os.tmpdir(), `alpr-world-${Date.now()}.json`);
  await fsp.writeFile(tempPath, body);
  console.log(`Raw response saved to ${tempPath} (${(body.length / 1048576).toFixed(1)} MB)`);
  return body;
}

function readmeText({ pack, droppedCount, osmTimestamp, sourceLabel }) {
  const c = pack.meta;
  return `# ALPR Cameras (bundled snapshot)

Worldwide OpenStreetMap extract of automatic-license-plate-reader cameras,
community-mapped predominantly through the [DeFlock](https://deflock.org)
project's tagging schema, bundled for the ALPR layer's globe-scale ambient
tier. The layer's live \`/api/alpr\` tier supersedes this snapshot inside a
zoomed-in viewport.

- Source: OpenStreetMap contributors (Overpass API)
- License: Open Database License (ODbL) 1.0 — https://www.openstreetmap.org/copyright
- Feature count: ${c.count.toLocaleString('en-US')} (${c.countByType.nodes.toLocaleString('en-US')} nodes, ${c.countByType.ways} ways, ${c.countByType.relations} relations; ${droppedCount} malformed/duplicate rows dropped)
- Vendors table: ${c.vendorCount} · Operators table: ${c.operatorCount}
- OSM data timestamp: ${osmTimestamp || 'not reported'}
- Extracted: ${c.retrievedAt} from ${sourceLabel}
- Query: \`${QUERY}\`
- Runtime file: \`cameras.json\` (format: \`src/data/alprPack.js\`, version ${c.version})
- Rebuild: \`node scripts/build-alpr-snapshot.mjs\`

Deterministic transform: coordinates rounded to 5 decimals (~1.1 m); kept tags
limited to manufacturer (brand fallback), operator, and parsed facing
direction(s); rows sorted by OSM id. The public-release snapshot drops any
kept value containing an email or phone identifier (the same rule as the
datacenters/dams snapshots) and caps values at ${MAX_VALUE_CHARS} chars.

Mapped presence is a community report, not an operator disclosure; coverage is
incomplete by nature, and the absence of a marker is never evidence a road is
unwatched. This derived database is distributed under ODbL 1.0 with the
required "© OpenStreetMap contributors" attribution.
`;
}

async function main() {
  const raw = FROM_FILE ? await fsp.readFile(FROM_FILE, 'utf8') : await download();
  const parsed = JSON.parse(raw);
  const osmTimestamp = parsed?.osm3s?.timestamp_osm_base || null;
  const { records, droppedCount } = normalizeSnapshotElements(parsed?.elements);
  if (records.length < 100000) {
    throw new Error(`Refusing to write a suspiciously small snapshot (${records.length} records) — worldwide coverage is ~147K+`);
  }
  const sourceLabel = FROM_FILE ? `a pre-downloaded Overpass response (${path.basename(FROM_FILE)})` : MIRROR;
  const pack = encodeAlprPack(records, {
    source: 'OpenStreetMap (Overpass API) — DeFlock community tagging schema',
    attribution: '© OpenStreetMap contributors (ODbL 1.0)',
    query: QUERY,
    osmTimestamp,
    retrievedAt: new Date().toISOString(),
  });
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const packPath = path.join(OUT_DIR, 'cameras.json');
  await fsp.writeFile(packPath, JSON.stringify(pack));
  await fsp.writeFile(path.join(OUT_DIR, 'README.md'), readmeText({ pack, droppedCount, osmTimestamp, sourceLabel }));
  const sizeMb = (fs.statSync(packPath).size / 1048576).toFixed(2);
  console.log(`Wrote ${packPath} — ${pack.meta.count.toLocaleString('en-US')} cameras, ${sizeMb} MB (${droppedCount} rows dropped)`);
  console.log(`Vendors: ${pack.meta.vendorCount} · Operators: ${pack.meta.operatorCount} · OSM data as of ${osmTimestamp || 'unknown'}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(`build-alpr-snapshot failed: ${error?.message || error}`);
    process.exit(1);
  });
}
