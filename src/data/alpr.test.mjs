import test from 'node:test';
import assert from 'node:assert/strict';
import alprLayer, {
  _ambientOcclusionSweep,
  _resetAlprLayerForTest,
  alprAccent,
  alprDetailLines,
  alprResponseSaturated,
  alprRetryDelayMs,
  alprWithinViewport,
} from './alpr.js';
import { encodeAlprPack } from './alprPack.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
} from '../renderGovernor.js';
import * as Cesium from 'cesium';

// Comfortably inside the 1° request window: an exactly-1° rectangle would
// round-trip through radians to a hair over the limit and read as zoom-out.
const VIEWPORT = { south: 30, west: -98, north: 30.8, east: -97.2 };

function alprNode(id, lat, lon, tags = {}) {
  return { type: 'node', id, lat, lon, tags: { 'surveillance:type': 'ALPR', ...tags } };
}

/** Two-camera bundled-snapshot fixture served whenever a test fetches the pack. */
function fixturePack() {
  return encodeAlprPack([
    { osmType: 'node', osmId: 1, latitude: 30.27, longitude: -97.74, manufacturer: 'Flock Safety', operator: null, directionsDeg: [87] },
    { osmType: 'node', osmId: 2, latitude: 51.5, longitude: -0.12, manufacturer: null, operator: null, directionsDeg: [] },
  ], { retrievedAt: '2026-08-29T00:00:00.000Z' });
}

/** Let the fire-and-forget pack load (fetch → decode → fill) settle. */
async function settlePack(ticks = 5) {
  for (let i = 0; i < ticks; i += 1) await new Promise((r) => setTimeout(r, 5));
}

/**
 * Drive one real `update()` of the layer against a stubbed proxy, and expose
 * what actually reached the map and the context store (same harness shape as
 * militaryInstallations.test.mjs).
 */
async function runAlprLoad({
  elements = [],
  saturated = false,
  exactElements = null,
  exactSaturated = false,
  failWith = null,
  packFail = false,
  globalView = false,
} = {}) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const requests = [];
  const contextEvents = [];
  let wideView = globalView;
  _resetRenderGovernorForTest();
  _resetAlprLayerForTest();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = {
    dispatchEvent(event) {
      if (event?.detail?.label) contextEvents.push(event.detail.label);
    },
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  };
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/terrain/heights')) {
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    }
    if (href.includes('cameras.json')) {
      if (packFail) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => fixturePack() };
    }
    requests.push(href);
    if (failWith) {
      return { ok: false, status: 503, json: async () => ({ error: failWith }) };
    }
    const exact = href.includes('exact=1');
    const payload = {
      status: 'fresh',
      retrievedAt: '2026-08-29T00:00:00.000Z',
      elements: exact && exactElements ? exactElements : elements,
      elementCap: 2500,
      saturated: exact ? exactSaturated : saturated,
    };
    return { ok: true, status: 200, json: async () => payload };
  };
  const dataSources = [];
  const primitives = [];
  const cameraFlights = [];
  const preUpdateListeners = new Set();
  const viewer = {
    camera: {
      // Parked above central Texas — near side for the Austin fixture camera,
      // far side for the London one.
      positionWC: Cesium.Cartesian3.fromDegrees(-97.5, 30.4, 400_000),
      moveEnd: { addEventListener() { return () => {}; } },
      flyToBoundingSphere(sphere, options) { cameraFlights.push({ sphere, options }); },
      computeViewRectangle() {
        // A cross-dateline/global view reports no usable rectangle.
        return wideView ? null : {
          south: Cesium.Math.toRadians(VIEWPORT.south),
          west: Cesium.Math.toRadians(VIEWPORT.west),
          north: Cesium.Math.toRadians(VIEWPORT.north),
          east: Cesium.Math.toRadians(VIEWPORT.east),
        };
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
      requestRenderMode: false,
      maximumRenderTimeChange: 0,
      requestRender() {},
      preUpdate: {
        addEventListener(listener) {
          preUpdateListeners.add(listener);
          return () => preUpdateListeners.delete(listener);
        },
      },
      primitives: {
        add(primitive) { primitives.push(primitive); return primitive; },
        remove(primitive) {
          const index = primitives.indexOf(primitive);
          if (index >= 0) primitives.splice(index, 1);
          return index >= 0;
        },
      },
    },
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };

  alprLayer.init(viewer);
  installRenderGovernor(viewer);
  alprLayer.enable();
  await alprLayer.update();

  return {
    requests,
    cameraFlights,
    entities: () => dataSources[0]?.entities?.values || [],
    packCollection: () => primitives[0] || null,
    setWideView(value) { wideView = value; },
    firePreUpdate() { for (const listener of preUpdateListeners) listener(); },
    contextLabels: () => contextEvents,
    stats: () => alprLayer.getStats(),
    renderRequests: () => getRenderGovernorDiagnostics().recentRequests.map((item) => item.reason),
    restore() {
      alprLayer.destroy(viewer);
      _resetRenderGovernorForTest();
      _resetAlprLayerForTest();
      globalThis.fetch = originalFetch;
      if (originalDocument === undefined) delete globalThis.document;
      else globalThis.document = originalDocument;
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    },
  };
}

test('every mapped camera is centre-tested against the requested viewport', () => {
  assert.equal(alprWithinViewport({ latitude: 30.5, longitude: -97.5 }, VIEWPORT), true);
  assert.equal(alprWithinViewport({ latitude: 30.5, longitude: -96.5 }, VIEWPORT), false);
  // Unlike installations, a way-mapped ALPR is a gantry a few metres long, so
  // even the extended features are safely centre-tested.
  assert.equal(alprWithinViewport({ osmType: 'way', latitude: 30.5, longitude: -96.99 }, VIEWPORT), false);
  assert.equal(alprWithinViewport(null, VIEWPORT), false);
  assert.equal(alprWithinViewport({ latitude: 30.5, longitude: -97.5 }, null), false);
});

test('saturation derives from the payload cap when the flag is missing', () => {
  assert.equal(alprResponseSaturated({ elements: new Array(5).fill({}), elementCap: 5 }), true);
  assert.equal(alprResponseSaturated({ elements: new Array(4).fill({}), elementCap: 5 }), false);
  assert.equal(alprResponseSaturated({ elements: new Array(5).fill({}), elementCap: 5, saturated: false }), false);
  assert.equal(alprResponseSaturated({ elements: new Array(5).fill({}) }), false, 'no cap, nothing to derive');
  assert.equal(alprResponseSaturated(null), false);
});

test('detail lines lead with facing, and accents stay vendor-honest', () => {
  assert.deepEqual(
    alprDetailLines({ directionsDeg: [45, 225], operator: 'City PD' }),
    ['FACING NE (45°) / SW (225°)', 'CITY PD'],
  );
  assert.deepEqual(alprDetailLines({ directionsDeg: [] }), ['LICENSE PLATE READER']);
  assert.notEqual(alprAccent({ manufacturerClass: 'flock' }), alprAccent({ manufacturerClass: 'unknown' }));
  assert.equal(
    alprAccent({ manufacturerClass: 'other' }),
    alprAccent({ manufacturerClass: 'unknown' }),
    'an unrecognized vendor never borrows a known vendor identity',
  );
});

test('the unavailable retry backs off 30s to a 240s ceiling and restarts clean', () => {
  assert.equal(alprRetryDelayMs(0), 30000);
  assert.equal(alprRetryDelayMs(undefined), 30000);
  assert.equal(alprRetryDelayMs(30000), 60000);
  assert.equal(alprRetryDelayMs(120000), 240000);
  assert.equal(alprRetryDelayMs(240000), 240000);
  assert.equal(alprRetryDelayMs(-5), 30000);
});

test('rendered cameras carry vendor styling and context, never native labels', async () => {
  const harness = await runAlprLoad({
    elements: [
      alprNode(101, 30.5, -97.5, { manufacturer: 'Flock Safety', direction: '45', operator: 'City PD' }),
      alprNode(102, 30.6, -97.6),
    ],
  });
  try {
    const entities = harness.entities();
    assert.equal(entities.length, 2);
    assert.ok(entities.every((entity) => entity.label === undefined), 'labels ride the overlay lane');
    const flock = entities.find((entity) => entity.id === 'osm:node:101');
    assert.equal(flock.gevLabelModel.title, 'Flock Safety ALPR');
    assert.deepEqual(flock.gevLabelModel.details, ['FACING NE (45°)', 'CITY PD']);
    assert.equal(flock.gevLabelModel.accent, alprAccent({ manufacturerClass: 'flock' }));
    assert.equal(harness.stats().count, 2);
    assert.equal(harness.stats().status, 'ready');
  } finally {
    harness.restore();
  }
});

test('off-viewport cameras from the snapped superset never render or enter context', async () => {
  const harness = await runAlprLoad({
    elements: [
      alprNode(1, 30.5, -97.5, { manufacturer: 'Flock Safety' }),
      // The snapped bbox reaches ~5.5 km beyond the viewport; this one sits a
      // full degree outside it.
      alprNode(2, 30.5, -96.2, { manufacturer: 'Flock Safety' }),
    ],
  });
  try {
    assert.deepEqual(harness.entities().map((entity) => entity.id), ['osm:node:1']);
    assert.equal(harness.stats().count, 1);
  } finally {
    harness.restore();
  }
});

test('a saturated snapped tile refetches the exact viewport before rendering', async () => {
  const elements = [];
  for (let index = 0; index < 2500; index += 1) {
    elements.push(alprNode(1000 + index, 30.5, -96.2));
  }
  const harness = await runAlprLoad({
    elements,
    saturated: true,
    exactElements: [alprNode(7, 30.5, -97.5, { manufacturer: 'Flock Safety' })],
  });
  try {
    assert.equal(harness.requests.length, 2, 'saturation triggers exactly one retry');
    assert.equal(harness.requests[0].includes('exact=1'), false);
    assert.equal(harness.requests[1].includes('exact=1'), true);
    assert.deepEqual(
      harness.entities().map((entity) => entity.id),
      ['osm:node:7'],
      'the in-viewport camera is no longer starved by off-view ones',
    );
  } finally {
    harness.restore();
  }
});

test('a still-saturated exact viewport is reported honestly instead of implied complete', async () => {
  const elements = [];
  for (let index = 0; index < 2500; index += 1) {
    elements.push(alprNode(2000 + index, 30.5, -97.5));
  }
  const harness = await runAlprLoad({ elements, saturated: true, exactSaturated: true });
  try {
    assert.equal(harness.stats().saturated, true);
    assert.match(harness.stats().error, /Too many mapped cameras/);
  } finally {
    harness.restore();
  }
});

test('an unsaturated response never pays for a second upstream ask', async () => {
  const harness = await runAlprLoad({ elements: [alprNode(3, 30.5, -97.5)] });
  try {
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.stats().saturated, false);
  } finally {
    harness.restore();
  }
});

test('a failed load buys the frame its status change needs', async () => {
  const harness = await runAlprLoad({ failWith: 'ALPR feed HTTP 503' });
  try {
    assert.equal(harness.stats().status, 'unavailable');
    assert.ok(
      harness.renderRequests().some((reason) => reason === 'alpr-status'),
      'an idle governor would otherwise leave the last healthy readout on screen',
    );
  } finally {
    harness.restore();
  }
});

test('focusing a rendered camera selects it and frames the block, not the region', async () => {
  const harness = await runAlprLoad({
    elements: [alprNode(11, 30.5, -97.5, { manufacturer: 'Flock Safety' })],
  });
  try {
    assert.equal(alprLayer.focusById('osm:node:11'), true);
    assert.equal(harness.cameraFlights.length, 1);
    assert.ok(harness.cameraFlights[0].sphere.radius <= 5000, 'street furniture framing');
    assert.equal(alprLayer.focusById('osm:node:404'), false, 'an unknown id never flies the camera');
  } finally {
    harness.restore();
  }
});

test('zoom-out aborts an active request and returns non-loading guidance', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let globalView = false;
  let observedSignal;
  _resetAlprLayerForTest();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async (url, options = {}) => {
    // The wide view triggers a snapshot load; refuse it fast so this test
    // still exercises the no-pack guidance path.
    if (String(url).includes('cameras.json')) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    observedSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };
  const viewer = {
    camera: {
      moveEnd: { addEventListener() { return () => {}; } },
      computeViewRectangle() {
        return globalView ? null : {
          south: Cesium.Math.toRadians(VIEWPORT.south),
          west: Cesium.Math.toRadians(VIEWPORT.west),
          north: Cesium.Math.toRadians(VIEWPORT.north),
          east: Cesium.Math.toRadians(VIEWPORT.east),
        };
      },
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick() { return null; },
      primitives: { add(value) { return value; }, remove() { return true; } },
    },
    dataSources: { add(value) { return value; }, remove() { return true; } },
  };

  try {
    alprLayer.init(viewer);
    alprLayer.enable();
    const pending = alprLayer.update();
    assert.equal(alprLayer.getStats().loading, true);
    assert.equal(alprLayer.getStats().loadingLabel, 'loading mapped ALPR cameras');
    globalView = true;
    await alprLayer.update();
    await pending;
    await settlePack();
    assert.equal(observedSignal.aborted, true);
    assert.equal(alprLayer.getStats().loading, false);
    assert.equal(alprLayer.getStats().status, 'zoom-in');
  } finally {
    alprLayer.destroy(viewer);
    _resetAlprLayerForTest();
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('a wide view renders the bundled worldwide snapshot instead of demanding a zoom', async () => {
  const harness = await runAlprLoad({ globalView: true });
  try {
    await settlePack();
    assert.equal(harness.stats().status, 'ready');
    assert.equal(harness.stats().count, 2, 'count reports the snapshot total');
    assert.equal(harness.requests.length, 0, 'no live Overpass request fires at wide zoom');
    const collection = harness.packCollection();
    assert.equal(collection.length, 2, 'both snapshot cameras became ambient points');
    assert.equal(collection.show, true);
    assert.equal(harness.stats().error, null);
  } finally {
    harness.restore();
  }
});

test('zooming into the window hands off from snapshot points to live entities', async () => {
  const harness = await runAlprLoad({
    globalView: true,
    elements: [alprNode(11, 30.5, -97.5, { manufacturer: 'Flock Safety' })],
  });
  try {
    await settlePack();
    assert.equal(harness.stats().count, 2, 'ambient regime reports the snapshot');
    harness.setWideView(false);
    await alprLayer.update();
    assert.equal(harness.stats().status, 'ready');
    assert.equal(harness.stats().count, 1, 'live viewport count replaces the snapshot total');
    assert.equal(harness.packCollection().show, false, 'ambient points retire when live coverage takes over');
    assert.equal(harness.entities().length, 1);
  } finally {
    harness.restore();
  }
});

test('a live failure keeps the snapshot as a fail-soft backdrop', async () => {
  const harness = await runAlprLoad({ failWith: 'ALPR feed HTTP 503' });
  try {
    await settlePack();
    assert.equal(harness.stats().status, 'unavailable');
    assert.equal(harness.packCollection().show, true, 'bundled dots beat an empty map while live retries');
    assert.equal(harness.packCollection().length, 2);
  } finally {
    harness.restore();
  }
});

test('a missing snapshot degrades the wide view to guidance, never a fault', async () => {
  const harness = await runAlprLoad({ globalView: true, packFail: true });
  try {
    await settlePack();
    assert.equal(harness.stats().status, 'zoom-in');
    assert.match(harness.stats().error, /Zoom in/);
    assert.equal(harness.stats().count, 0);
    assert.equal(harness.stats().loading, false);
    assert.equal(harness.packCollection().length, 0);
  } finally {
    harness.restore();
  }
});

test('far-side ambient points are horizon-culled instead of bleeding through the globe', () => {
  const collection = new Cesium.PointPrimitiveCollection();
  collection.add({ position: Cesium.Cartesian3.fromDegrees(-97.7, 30.3) });  // Austin
  collection.add({ position: Cesium.Cartesian3.fromDegrees(151.2, -33.9) }); // Sydney
  const overUS = Cesium.Cartesian3.fromDegrees(-97, 35, 5_500_000);
  assert.equal(_ambientOcclusionSweep(collection, overUS), 1);
  assert.equal(collection.get(0).show, true, 'the near-side point stays visible');
  assert.equal(collection.get(1).show, false, 'the far-side point is hidden by the planet');
  // Flying to the far side flips both verdicts.
  const overAU = Cesium.Cartesian3.fromDegrees(151, -30, 5_500_000);
  assert.equal(_ambientOcclusionSweep(collection, overAU), 1);
  assert.equal(collection.get(0).show, false);
  assert.equal(collection.get(1).show, true);
  collection.destroy();
});

test('the ambient tier sweeps on the frame gate: US camera hides the London fixture point', async () => {
  const harness = await runAlprLoad({ globalView: true });
  try {
    await settlePack();
    const collection = harness.packCollection();
    assert.equal(collection.length, 2);
    harness.firePreUpdate();
    // Fixture row order is by OSM id: 1 = Austin, 2 = London.
    assert.equal(collection.get(0).show, true, 'Austin is on the near side of the Texas camera');
    assert.equal(collection.get(1).show, false, 'London sits beyond the horizon and must not bleed through');
  } finally {
    harness.restore();
  }
});
