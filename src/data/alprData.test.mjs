import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAlprManufacturer,
  compassLabel,
  normalizeAlprCameras,
  parseCameraDirections,
} from './alprData.js';

test('facing tags parse numeric, cardinal, worded, and multi-head values', () => {
  assert.deepEqual(parseCameraDirections('45'), [45]);
  assert.deepEqual(parseCameraDirections('360'), [0], 'degrees normalize into [0, 360)');
  assert.deepEqual(parseCameraDirections('-90'), [270]);
  assert.deepEqual(parseCameraDirections('NE'), [45]);
  assert.deepEqual(parseCameraDirections('nne'), [22.5]);
  assert.deepEqual(parseCameraDirections('north'), [0]);
  assert.deepEqual(parseCameraDirections('45;225'), [45, 225], 'dual-head mounts keep both facings');
  assert.deepEqual(parseCameraDirections('45; garbage ;W'), [45, 270], 'unparseable parts are dropped, not guessed');
  assert.deepEqual(parseCameraDirections(''), []);
  assert.deepEqual(parseCameraDirections(undefined), []);
});

test('compass labels read as a point plus rounded degrees', () => {
  assert.equal(compassLabel(45), 'NE (45°)');
  assert.equal(compassLabel(0), 'N (0°)');
  assert.equal(compassLabel(359), 'N (359°)', 'near-north rounds to the N point');
  assert.equal(compassLabel(202.5), 'SSW (203°)');
});

test('manufacturer buckets match the dominant vendors and never invent one', () => {
  assert.equal(classifyAlprManufacturer('Flock Safety'), 'flock');
  assert.equal(classifyAlprManufacturer('Motorola Solutions'), 'motorola');
  assert.equal(classifyAlprManufacturer('Vigilant Solutions'), 'motorola');
  assert.equal(classifyAlprManufacturer('Genetec AutoVu'), 'genetec');
  assert.equal(classifyAlprManufacturer('Leonardo ELSAG'), 'leonardo');
  assert.equal(classifyAlprManufacturer('Some Startup'), 'other');
  assert.equal(classifyAlprManufacturer(''), 'unknown');
  assert.equal(classifyAlprManufacturer(undefined), 'unknown');
});

test('normalization produces human titles, never a bare OSM id as a name', () => {
  const { records, droppedCount } = normalizeAlprCameras({
    elements: [
      {
        type: 'node',
        id: 101,
        lat: 30.2,
        lon: -97.7,
        tags: {
          'surveillance:type': 'ALPR',
          manufacturer: 'Flock Safety',
          operator: 'City Police Department',
          direction: '45',
          'surveillance:zone': 'traffic',
        },
      },
      { type: 'node', id: 102, lat: 30.21, lon: -97.71, tags: { 'surveillance:type': 'ALPR' } },
    ],
  }, '2026-08-29T00:00:00.000Z');
  assert.equal(droppedCount, 0);
  assert.equal(records.length, 2);
  const [flock, anonymous] = records;
  assert.equal(flock.id, 'osm:node:101');
  assert.equal(flock.name, 'Flock Safety ALPR');
  assert.equal(flock.manufacturerClass, 'flock');
  assert.equal(flock.operator, 'City Police Department');
  assert.deepEqual(flock.directionsDeg, [45]);
  assert.equal(flock.zone, 'traffic');
  assert.deepEqual(flock.sources, [{ name: 'OpenStreetMap', id: 'node/101', retrievedAt: '2026-08-29T00:00:00.000Z' }]);
  assert.equal(flock.validation, 'unreviewed');
  assert.equal(anonymous.name, 'ALPR camera', 'no vendor tag reads as a plain camera, not an id');
  assert.equal(anonymous.manufacturerClass, 'unknown');
});

test('non-ALPR, malformed, and duplicate elements are dropped, way centres kept', () => {
  const { records, droppedCount } = normalizeAlprCameras({
    elements: [
      // A stale cache entry smuggling in another camera kind must not render.
      { type: 'node', id: 1, lat: 30, lon: -97, tags: { 'surveillance:type': 'camera' } },
      { type: 'node', id: 2, lat: 999, lon: -97, tags: { 'surveillance:type': 'ALPR' } },
      { type: 'node', id: 3, lat: 30, lon: -97, tags: { 'surveillance:type': 'ALPR' } },
      { type: 'node', id: 3, lat: 30, lon: -97, tags: { 'surveillance:type': 'ALPR' } },
      { type: 'way', id: 4, center: { lat: 30.1, lon: -97.1 }, tags: { 'surveillance:type': 'ALPR', 'camera:direction': 'SW' } },
      { type: 'chunk', id: 5, lat: 30, lon: -97, tags: { 'surveillance:type': 'ALPR' } },
    ],
  });
  assert.equal(records.length, 2);
  assert.equal(droppedCount, 4);
  assert.equal(records[1].id, 'osm:way:4');
  assert.equal(records[1].latitude, 30.1);
  assert.deepEqual(records[1].directionsDeg, [225], 'camera:direction is the facing fallback');
});

test('the brand tag backs up a missing manufacturer and long values are bounded', () => {
  const { records } = normalizeAlprCameras({
    elements: [
      { type: 'node', id: 7, lat: 1, lon: 1, tags: { 'surveillance:type': 'ALPR', brand: 'Flock Safety' } },
      { type: 'node', id: 8, lat: 1, lon: 2, tags: { 'surveillance:type': 'ALPR', manufacturer: 'x'.repeat(300) } },
    ],
  });
  assert.equal(records[0].manufacturer, 'Flock Safety');
  assert.equal(records[0].manufacturerClass, 'flock');
  assert.equal(records[1].manufacturer.length, 80, 'display tags are truncated, not trusted');
});

test('an empty or malformed payload normalizes to nothing rather than throwing', () => {
  assert.deepEqual(normalizeAlprCameras({}), { records: [], droppedCount: 0 });
  assert.deepEqual(normalizeAlprCameras(null), { records: [], droppedCount: 0 });
  assert.deepEqual(normalizeAlprCameras({ elements: 'nope' }), { records: [], droppedCount: 0 });
});
