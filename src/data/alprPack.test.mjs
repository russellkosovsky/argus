import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ALPR_AMBIENT_CLASSES,
  ALPR_PACK_VERSION,
  decodeAlprPack,
  encodeAlprPack,
} from './alprPack.js';
import {
  normalizeSnapshotElements,
  sanitizePackValue,
} from '../../scripts/build-alpr-snapshot.mjs';

function record(overrides = {}) {
  return {
    osmType: 'node',
    osmId: 101,
    latitude: 30.2011175,
    longitude: -97.7667709,
    manufacturer: 'Flock Safety',
    operator: 'City Police Department',
    directionsDeg: [87],
    ...overrides,
  };
}

test('encode/decode round-trips positions, vendor classes, and counts', () => {
  const records = [
    record(),
    record({ osmId: 102, latitude: 30.21, longitude: -97.71, manufacturer: 'Genetec AutoVu', directionsDeg: [45, 225] }),
    record({ osmId: 103, latitude: -33.87, longitude: 151.21, manufacturer: null, operator: null, directionsDeg: [] }),
    record({ osmId: 5, osmType: 'way', latitude: 51.5, longitude: -0.12, manufacturer: 'Jenoptik' }),
  ];
  const pack = encodeAlprPack(records, { note: 'fixture' });
  assert.equal(pack.meta.version, ALPR_PACK_VERSION);
  assert.equal(pack.meta.count, 4);
  assert.deepEqual(pack.meta.countByType, { nodes: 3, ways: 1, relations: 0 });
  assert.equal(pack.meta.note, 'fixture', 'caller provenance survives verbatim');

  const decoded = decodeAlprPack(pack);
  assert.equal(decoded.count, 4);
  assert.equal(decoded.droppedCount, 0);
  // 5-decimal rounding (~1.1 m) is the format's stated precision.
  assert.ok(Math.abs(decoded.lonDeg[0] - -97.76677) < 1e-9);
  assert.ok(Math.abs(decoded.latDeg[0] - 30.20112) < 1e-9);
  const classOf = (index) => ALPR_AMBIENT_CLASSES[decoded.vendorClass[index]];
  assert.equal(classOf(0), 'flock');
  assert.equal(classOf(1), 'genetec');
  assert.equal(classOf(2), 'unknown', 'untagged cameras never borrow a vendor identity');
  assert.equal(classOf(3), 'jenoptik');
});

test('rows sort by OSM id so a rebuild with identical data is byte-identical', () => {
  const shuffled = [record({ osmId: 9 }), record({ osmId: 2 }), record({ osmId: 5 })];
  const pack = encodeAlprPack(shuffled, {});
  assert.deepEqual(pack.nodes.map((row) => row[0]), [2, 5, 9]);
  assert.equal(
    JSON.stringify({ ...pack, meta: null }),
    JSON.stringify({ ...encodeAlprPack([...shuffled].reverse(), {}), meta: null }),
  );
});

test('direction encoding: none is -1, one is an int, multi-head keeps every facing', () => {
  const pack = encodeAlprPack([
    record({ osmId: 1, directionsDeg: [] }),
    record({ osmId: 2, directionsDeg: [87.4] }),
    record({ osmId: 3, directionsDeg: [45, 225] }),
    record({ osmId: 4, directionsDeg: [359.7] }),
  ], {});
  assert.deepEqual(pack.nodes.map((row) => row[5]), [-1, 87, [45, 225], 0]);
});

test('a wrong pack version is refused outright, never half-decoded', () => {
  assert.throws(() => decodeAlprPack({ meta: { version: 999 } }), /Unsupported ALPR pack version/);
  assert.throws(() => decodeAlprPack(null), /Unsupported ALPR pack version/);
});

test('malformed rows are dropped and counted, not guessed at', () => {
  const pack = encodeAlprPack([record()], {});
  pack.nodes.push([7, 99_000_000, 0, -1, -1, -1]); // longitude 990 — off the globe
  pack.nodes.push(['nope']);
  const decoded = decodeAlprPack(pack);
  assert.equal(decoded.count, 1);
  assert.equal(decoded.droppedCount, 2);
});

test('snapshot normalization mirrors the live rules: dedupe, bounds, way centres', () => {
  const { records, droppedCount } = normalizeSnapshotElements([
    { type: 'node', id: 1, lat: 30, lon: -97, tags: { manufacturer: 'Flock Safety', direction: '45' } },
    { type: 'node', id: 1, lat: 30, lon: -97, tags: {} },
    { type: 'node', id: 2, lat: 999, lon: -97, tags: {} },
    { type: 'way', id: 3, center: { lat: 51.5, lon: -0.12 }, tags: { brand: 'Jenoptik', 'camera:direction': 'SW' } },
    { type: 'chunk', id: 4, lat: 30, lon: -97, tags: {} },
  ]);
  assert.equal(records.length, 2);
  assert.equal(droppedCount, 3);
  assert.equal(records[0].manufacturer, 'Flock Safety');
  assert.deepEqual(records[0].directionsDeg, [45]);
  assert.equal(records[1].osmType, 'way');
  assert.equal(records[1].manufacturer, 'Jenoptik', 'brand backs up a missing manufacturer');
  assert.deepEqual(records[1].directionsDeg, [225]);
});

test('the public-release privacy rule drops contact identifiers', () => {
  assert.equal(sanitizePackValue('City Police Department'), 'City Police Department');
  assert.equal(sanitizePackValue('ops@vendor.example'), null);
  assert.equal(sanitizePackValue('Dispatch +1 (512) 555-0100'), null);
  assert.equal(sanitizePackValue('   '), null);
  assert.equal(sanitizePackValue('x'.repeat(300)).length, 80);
});

test('the committed bundled snapshot decodes and is worldwide-scale', () => {
  const packPath = new URL('./local_data/alpr/cameras.json', import.meta.url);
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  const decoded = decodeAlprPack(pack);
  assert.equal(pack.meta.version, ALPR_PACK_VERSION);
  assert.ok(decoded.count > 100_000, `worldwide coverage is ~147K+, decoded ${decoded.count}`);
  assert.equal(decoded.droppedCount, 0, 'the committed pack must decode losslessly');
  assert.ok(pack.meta.retrievedAt, 'provenance records the extraction time');
  assert.ok(pack.meta.query?.includes('surveillance:type'), 'provenance records the exact query');
  // The dominant mapped vendor must classify — the ambient tier's color story
  // depends on it.
  const flockShare = decoded.vendorClass.reduce(
    (sum, klass) => sum + (ALPR_AMBIENT_CLASSES[klass] === 'flock' ? 1 : 0),
    0,
  ) / decoded.count;
  assert.ok(flockShare > 0.5, `Flock Safety should dominate the mapped fleet (got ${(flockShare * 100).toFixed(1)}%)`);
});
