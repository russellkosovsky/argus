/**
 * Normalize the viewport-bounded ALPR camera context returned by `/api/alpr`.
 *
 * These are community-mapped OpenStreetMap features (`man_made=surveillance` +
 * `surveillance:type=ALPR`), overwhelmingly contributed through the DeFlock
 * project (deflock.org). Mapped presence is a crowd report, not an operator
 * disclosure — and absence of a marker is never evidence a road is unwatched.
 */

/**
 * Vendor buckets for the manufacturers that dominate the mapped ALPR fleet
 * (taginfo 2026-08-29: `manufacturer` is present on 86.7% of ALPR nodes and
 * Flock Safety alone accounts for ~73%). Everything else stays a labeled
 * catch-all rather than inventing per-vendor claims.
 */
const MANUFACTURER_CLASS_PATTERNS = [
  ['flock', /flock/i],
  ['motorola', /motorola|vigilant/i],
  ['genetec', /genetec|autovu/i],
  ['leonardo', /leonardo|elsag/i],
  ['neology', /neology|pips/i],
  ['jenoptik', /jenoptik/i],
];

const COMPASS_POINTS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

const CARDINAL_WORDS = { north: 'N', east: 'E', south: 'S', west: 'W' };

const MAX_TAG_DISPLAY_CHARS = 80;

/**
 * Vendor bucket for a raw `manufacturer`/`brand` tag value.
 * @param {unknown} value Raw tag value.
 * @returns {string} One of the known buckets, 'other', or 'unknown'.
 */
export function classifyAlprManufacturer(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'unknown';
  for (const [klass, pattern] of MANUFACTURER_CLASS_PATTERNS) {
    if (pattern.test(text)) return klass;
  }
  return 'other';
}

/**
 * Parse an OSM camera facing tag into degrees.
 *
 * The wild values are numeric ("45"), 16-point cardinal ("NE"), full words
 * ("north"), and semicolon lists for multi-head mounts ("45;225"). Unparseable
 * parts are dropped rather than guessed — a wrong facing claim is worse than
 * none.
 * @param {unknown} value Raw `direction` / `camera:direction` tag value.
 * @returns {number[]} Facing directions in [0, 360), possibly empty.
 */
export function parseCameraDirections(value) {
  const directions = [];
  for (const rawPart of String(value ?? '').split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    const numeric = Number(part);
    if (Number.isFinite(numeric)) {
      directions.push(((numeric % 360) + 360) % 360);
      continue;
    }
    const compact = CARDINAL_WORDS[part.toLowerCase()] || part.toUpperCase();
    const pointIndex = COMPASS_POINTS.indexOf(compact);
    if (pointIndex >= 0) directions.push(pointIndex * 22.5);
  }
  return directions;
}

/**
 * Compass label for one facing direction, e.g. "NE (45°)".
 * @param {number} degrees Direction in [0, 360).
 * @returns {string}
 */
export function compassLabel(degrees) {
  const normalized = ((degrees % 360) + 360) % 360;
  const point = COMPASS_POINTS[Math.round(normalized / 22.5) % 16];
  return `${point} (${Math.round(normalized)}°)`;
}

function finiteLatitude(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function finiteLongitude(value) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function pointFrom(element) {
  const latitude = Number(element?.lat ?? element?.center?.lat);
  const longitude = Number(element?.lon ?? element?.center?.lon);
  return finiteLatitude(latitude) && finiteLongitude(longitude) ? { latitude, longitude } : null;
}

function displayTag(value) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, MAX_TAG_DISPLAY_CHARS) : null;
}

/**
 * Convert a server-filtered Overpass ALPR payload into display records.
 *
 * An unnamed camera reads as its vendor ("Flock Safety ALPR") or a plain
 * "ALPR camera" — never a bare OSM primary key shown as if it were a name.
 * The OSM id survives on `id` and `sources[].id` for attribution and details.
 * @param {{elements?: Array}} payload
 * @param {string} [retrievedAt]
 * @returns {{records: Array, droppedCount: number}}
 */
export function normalizeAlprCameras(payload, retrievedAt = new Date().toISOString()) {
  const records = [];
  const ids = new Set();
  let droppedCount = 0;
  for (const element of Array.isArray(payload?.elements) ? payload.elements : []) {
    const type = String(element?.type || '');
    const osmId = Number(element?.id);
    if (!['node', 'way', 'relation'].includes(type) || !Number.isSafeInteger(osmId)) {
      droppedCount += 1;
      continue;
    }
    const id = `osm:${type}:${osmId}`;
    const tags = element?.tags || {};
    const point = pointFrom(element);
    // The endpoint only queries ALPR-tagged features; re-checking here keeps a
    // stale or hand-edited cache entry from smuggling in another camera kind.
    const isAlpr = /alpr/i.test(String(tags['surveillance:type'] || ''));
    if (!isAlpr || !point || ids.has(id)) {
      droppedCount += 1;
      continue;
    }
    ids.add(id);
    const manufacturer = displayTag(tags.manufacturer) || displayTag(tags.brand);
    records.push({
      id,
      kind: 'alpr',
      osmType: type,
      name: manufacturer ? `${manufacturer} ALPR` : 'ALPR camera',
      manufacturer,
      manufacturerClass: classifyAlprManufacturer(manufacturer),
      operator: displayTag(tags.operator),
      directionsDeg: parseCameraDirections(tags.direction ?? tags['camera:direction']),
      zone: displayTag(tags['surveillance:zone']),
      ...point,
      sources: [{ name: 'OpenStreetMap', id: `${type}/${osmId}`, retrievedAt }],
      validation: 'unreviewed',
      retrievedAt,
    });
  }
  return { records, droppedCount };
}
