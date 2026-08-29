// ALPR proxy request contract. The cache mechanics (outward snap, tier order,
// atomic disk writes, serve-stale) are the generic militaryInstallation*
// helpers already exercised end-to-end by installationProxy.test.mjs; what is
// pinned here is the ALPR endpoint's own contract — its tighter bbox window,
// its element cap travelling with the payload, and its disk namespace staying
// disjoint from the installation cache.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ALPR_ELEMENT_CAP,
  ALPR_MAX_BBOX_DEG,
  militaryInstallationCacheKey,
  militaryInstallationDiskPath,
  quantizeMilitaryInstallationBox,
  readMilitaryInstallationDisk,
  validAlprBox,
  validMilitaryInstallationBox,
  writeMilitaryInstallationDisk,
} from '../../vite.config.js';

function params(box) {
  return new URLSearchParams(Object.entries(box).map(([key, value]) => [key, String(value)]));
}

test('the ALPR bbox window is city-scale: 1 degree, non-dateline, well-formed', () => {
  assert.equal(ALPR_MAX_BBOX_DEG, 1);
  const good = validAlprBox(params({ south: 30.1, west: -97.9, north: 30.4, east: -97.5 }));
  assert.deepEqual(good, { south: 30.1, west: -97.9, north: 30.4, east: -97.5 });

  // A span the installation endpoint would accept is too large here: dense-tag
  // ALPR queries above ~1 degree measured 7-20 s upstream and reliably blew
  // the mirror walk when public capacity was degraded (2026-08-29).
  const wide = { south: 30, west: -98.5, north: 31.5, east: -97 };
  assert.equal(validAlprBox(params(wide)), null, 'a 1.5-degree box is rejected');
  assert.ok(validMilitaryInstallationBox(params(wide)), 'while the 10-degree installation window still takes it');

  assert.equal(validAlprBox(params({ south: 30, west: 179, north: 31, east: -179 })), null, 'dateline crossers are rejected');
  assert.equal(validAlprBox(params({ south: 31, west: -97, north: 30, east: -96 })), null, 'inverted latitudes are rejected');
  assert.equal(validAlprBox(params({ south: 30, west: -97, north: 31 })), null, 'a missing edge is rejected');
  assert.equal(validAlprBox(params({ south: 'x', west: -97, north: 31, east: -96 })), null);
});

test('the element cap is high enough for a dense metro', () => {
  // 700 (the installation cap) is demonstrably too small for mapped ALPR
  // density in US metros; the cap must stay comfortably above it.
  assert.ok(ALPR_ELEMENT_CAP >= 2000);
});

test('a payload at the cap reads as saturated through the client fallback', async () => {
  const { alprResponseSaturated } = await import('./alpr.js');
  assert.equal(
    alprResponseSaturated({ elements: new Array(ALPR_ELEMENT_CAP).fill({}), elementCap: ALPR_ELEMENT_CAP }),
    true,
  );
  assert.equal(
    alprResponseSaturated({ elements: new Array(ALPR_ELEMENT_CAP - 1).fill({}), elementCap: ALPR_ELEMENT_CAP }),
    false,
  );
  assert.equal(alprResponseSaturated({ elements: [], saturated: true }), true, 'an explicit flag always wins');
});

test('ALPR disk entries live in their own namespace and round-trip intact', async () => {
  const alprDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-alpr-'));
  const installationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-installations-'));
  const key = militaryInstallationCacheKey(
    quantizeMilitaryInstallationBox({ south: 30.26, west: -97.74, north: 30.29, east: -97.71 }),
  );
  const entry = {
    payload: {
      elements: [{ type: 'node', id: 1, lat: 30.27, lon: -97.72, tags: { 'surveillance:type': 'ALPR' } }],
      saturated: false,
      elementCap: ALPR_ELEMENT_CAP,
      retrievedAt: '2026-08-29T00:00:00.000Z',
      status: 'ready',
    },
    cachedAt: Date.now(),
  };
  try {
    assert.equal(await writeMilitaryInstallationDisk(key, entry, alprDir), true);
    // Same key, different directory: the two caches can never serve each other.
    assert.notEqual(
      militaryInstallationDiskPath(key, alprDir),
      militaryInstallationDiskPath(key, installationsDir),
    );
    assert.equal(await readMilitaryInstallationDisk(key, 60_000, installationsDir), null);
    const read = await readMilitaryInstallationDisk(key, 60_000, alprDir);
    assert.deepEqual(read.payload.elements, entry.payload.elements);
    assert.equal(read.payload.saturated, false, 'the explicit flag survives the migration shim untouched');
  } finally {
    await fsp.rm(alprDir, { recursive: true, force: true });
    await fsp.rm(installationsDir, { recursive: true, force: true });
  }
});
