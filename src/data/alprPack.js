/**
 * Compact bundled-snapshot format for the ALPR camera layer.
 *
 * The worldwide `surveillance:type=ALPR` extract (~147K features) is far too
 * large for GeoJSON(L), so the snapshot stores integer-scaled coordinates and
 * string-table indexes. One module owns BOTH directions of the format —
 * `scripts/build-alpr-snapshot.mjs` encodes, the layer decodes — so the two
 * can never drift apart and the round trip is unit-testable.
 *
 * Row shape (per feature, sorted by OSM id within each type):
 *   [osmId, lonE5, latE5, vendorIdx, operatorIdx, dir]
 *   - lonE5/latE5: degrees × 1e5, rounded (≈1.1 m — real precision for a
 *     street-furniture dot).
 *   - vendorIdx/operatorIdx: index into the `vendors`/`operators` tables,
 *     -1 = untagged.
 *   - dir: -1 = no facing tag, 0-359 = single facing, array of 0-359 for
 *     multi-head mounts.
 */

import { classifyAlprManufacturer } from './alprData.js';

export const ALPR_PACK_VERSION = 1;
export const ALPR_PACK_COORD_SCALE = 1e5;

/**
 * Ambient vendor buckets, indexed for the decoded Uint8Array. Order is a
 * DECODE-TIME contract only (classes are derived from the vendor table, never
 * stored), so appending here is always safe.
 */
export const ALPR_AMBIENT_CLASSES = Object.freeze([
  'unknown', 'other', 'flock', 'motorola', 'genetec', 'leonardo', 'neology', 'jenoptik',
]);

const OSM_TYPES = ['nodes', 'ways', 'relations'];

function roundE5(value) {
  return Math.round(value * ALPR_PACK_COORD_SCALE);
}

function encodeDirections(directionsDeg) {
  if (!Array.isArray(directionsDeg) || !directionsDeg.length) return -1;
  const rounded = directionsDeg.map((deg) => Math.round(((deg % 360) + 360) % 360) % 360);
  return rounded.length === 1 ? rounded[0] : rounded;
}

/**
 * Encode normalized camera records into the bundled pack shape.
 * @param {Array<{osmType:string, osmId:number, latitude:number, longitude:number,
 *   manufacturer:?string, operator:?string, directionsDeg:number[]}>} records
 * @param {object} meta Provenance block written verbatim (plus derived counts).
 * @returns {object} JSON-serializable pack.
 */
export function encodeAlprPack(records, meta = {}) {
  const vendors = [...new Set(records.map((r) => r.manufacturer).filter(Boolean))].sort();
  const operators = [...new Set(records.map((r) => r.operator).filter(Boolean))].sort();
  const vendorIndex = new Map(vendors.map((value, index) => [value, index]));
  const operatorIndex = new Map(operators.map((value, index) => [value, index]));
  const byType = { nodes: [], ways: [], relations: [] };
  for (const record of records) {
    const bucket = byType[`${record.osmType}s`];
    if (!bucket) continue;
    bucket.push([
      record.osmId,
      roundE5(record.longitude),
      roundE5(record.latitude),
      record.manufacturer ? vendorIndex.get(record.manufacturer) : -1,
      record.operator ? operatorIndex.get(record.operator) : -1,
      encodeDirections(record.directionsDeg),
    ]);
  }
  for (const type of OSM_TYPES) byType[type].sort((a, b) => a[0] - b[0]);
  const count = OSM_TYPES.reduce((sum, type) => sum + byType[type].length, 0);
  return {
    meta: {
      ...meta,
      version: ALPR_PACK_VERSION,
      coordScale: ALPR_PACK_COORD_SCALE,
      count,
      countByType: Object.fromEntries(OSM_TYPES.map((type) => [type, byType[type].length])),
      vendorCount: vendors.length,
      operatorCount: operators.length,
    },
    vendors,
    operators,
    ...byType,
  };
}

/**
 * Decode a bundled pack into flat parallel arrays for the ambient point tier.
 *
 * Deliberately does NOT materialize 147K record objects: the ambient tier only
 * needs positions and a vendor bucket per camera, so the decode stays at two
 * Float64Arrays plus one Uint8Array. Malformed rows are skipped and counted,
 * never guessed at.
 * @param {object} pack Parsed pack JSON.
 * @returns {{meta: object, count: number, droppedCount: number,
 *   lonDeg: Float64Array, latDeg: Float64Array, vendorClass: Uint8Array,
 *   vendors: string[], operators: string[]}}
 */
export function decodeAlprPack(pack) {
  if (!pack || pack.meta?.version !== ALPR_PACK_VERSION) {
    throw new Error(`Unsupported ALPR pack version: ${pack?.meta?.version ?? 'missing'}`);
  }
  const scale = Number(pack.meta.coordScale) || ALPR_PACK_COORD_SCALE;
  const vendors = Array.isArray(pack.vendors) ? pack.vendors : [];
  const operators = Array.isArray(pack.operators) ? pack.operators : [];
  const classByVendorIndex = vendors.map((vendor) => {
    const index = ALPR_AMBIENT_CLASSES.indexOf(classifyAlprManufacturer(vendor));
    return index >= 0 ? index : ALPR_AMBIENT_CLASSES.indexOf('other');
  });
  const unknownClass = ALPR_AMBIENT_CLASSES.indexOf('unknown');
  const rows = OSM_TYPES.flatMap((type) => (Array.isArray(pack[type]) ? pack[type] : []));
  const lonDeg = new Float64Array(rows.length);
  const latDeg = new Float64Array(rows.length);
  const vendorClass = new Uint8Array(rows.length);
  let count = 0;
  let droppedCount = 0;
  for (const row of rows) {
    const longitude = Number(row?.[1]) / scale;
    const latitude = Number(row?.[2]) / scale;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180
      || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      droppedCount += 1;
      continue;
    }
    const vendorIdx = Number(row[3]);
    lonDeg[count] = longitude;
    latDeg[count] = latitude;
    vendorClass[count] = classByVendorIndex[vendorIdx] ?? unknownClass;
    count += 1;
  }
  return {
    meta: pack.meta,
    count,
    droppedCount,
    lonDeg: lonDeg.subarray(0, count),
    latDeg: latDeg.subarray(0, count),
    vendorClass,
    vendors,
    operators,
  };
}
