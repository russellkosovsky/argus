import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import {
  cachedGroundFloor,
  floorAltitudeM,
  resolveGroundFloorCellsBounded,
} from './groundFloor.js';
// The shared batched/chunked/session-cached DEM warm chain (module name is
// historical; the mechanism is generic — see militaryInstallations.js).
import { warmFireAnchorFloors } from './fireAnchors.js';
import { compassLabel, normalizeAlprCameras } from './alprData.js';
import { ALPR_AMBIENT_CLASSES, decodeAlprPack } from './alprPack.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

/**
 * Bundled worldwide snapshot (see scripts/build-alpr-snapshot.mjs) backing the
 * globe-scale ambient tier. `new URL(..., import.meta.url)` is Vite's
 * no-bundle asset reference: the ~7 MB pack stays a cacheable static file and
 * is fetched lazily on first enable, never baked into a JS chunk.
 */
const PACK_URL = new URL('./local_data/alpr/cameras.json', import.meta.url).href;
/** Points added per macrotask while filling the ambient collection, so a
 * ~147K-point fill cannot freeze the frame it lands on. */
const PACK_FILL_BATCH = 20000;
const AMBIENT_POINT_PX = 3;
/** Minimum interval between horizon-culling sweeps of the ambient points. */
const AMBIENT_SWEEP_MIN_MS = 150;

const LAYER_ID = 'alpr';
const REQUEST_DEBOUNCE_MS = 500;
/**
 * ALPR cameras are street furniture and the mapped fleet is dense (~147K
 * worldwide, heavily clustered in US metros), so the request window is much
 * tighter than the 10° installations use. Must stay in lockstep with the
 * server's ALPR_MAX_BBOX_DEG (vite.config.js) or in-range viewports would be
 * answered with 400s: 1° (~110 km) frames a city and keeps the Overpass query
 * inside the slow-class mirror budget (dense-metro boxes at 2-4° measured
 * 7-20 s upstream and reliably blew the mirror walk when public capacity was
 * degraded — field report 2026-08-29).
 */
const MAX_VIEWPORT_DEGREES = 1;
const MAX_RENDERED = 1200;
/**
 * Accent per vendor bucket (see classifyAlprManufacturer). Unknown/other stay
 * a neutral grey rather than borrowing a vendor identity.
 */
const COLOR_BY_MANUFACTURER = {
  flock: '#ff5d73',
  motorola: '#5aa9ff',
  genetec: '#48c7d5',
  leonardo: '#d9a85d',
  neology: '#c58cff',
  jenoptik: '#8be0a4',
};
const DEFAULT_ACCENT = '#9ca6b0';
const EARTH_MEAN_RADIUS_M = 6371008.8;
const DISTANCE_PREFILTER_MARGIN_M = 5000;
const distanceEndpointScratch = new Cesium.Cartographic();
const distanceGeodesicScratch = new Cesium.EllipsoidGeodesic();

/**
 * Allocation-free spherical distance used only as a conservative rejection
 * pass before the exact ellipsoidal geodesic calculation.
 */
function approximateSurfaceDistanceM(latitudeARad, longitudeARad, latitudeBDeg, longitudeBDeg) {
  const latitudeBRad = Cesium.Math.toRadians(latitudeBDeg);
  const longitudeBRad = Cesium.Math.toRadians(longitudeBDeg);
  const latitudeDelta = latitudeBRad - latitudeARad;
  const longitudeDelta = Math.atan2(
    Math.sin(longitudeBRad - longitudeARad),
    Math.cos(longitudeBRad - longitudeARad),
  );
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const haversine = sinLatitude * sinLatitude
    + Math.cos(latitudeARad) * Math.cos(latitudeBRad) * sinLongitude * sinLongitude;
  return 2 * EARTH_MEAN_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

const state = {
  viewer: null,
  dataSource: null,
  enabled: false,
  records: [],
  recordById: new Map(),
  selectedId: null,
  lastUpdate: null,
  error: null,
  status: 'idle',
  stale: false,
  /** Whether the upstream truncated at its element cap for the current view. */
  saturated: false,
  loading: false,
  abort: null,
  /** Pending timed retry while status is 'unavailable' (see scheduleUnavailableRetry). */
  retryTimer: null,
  /** Current backoff step for that retry; 0 = next failure starts at the minimum. */
  retryDelayMs: 0,
  moveEndRemove: null,
  clickHandler: null,
  timer: null,
  /** True while the viewport is wider than the live request window. */
  ambient: false,
  /** Decoded bundled snapshot (survives destroy/init cycles). */
  pack: null,
  packCollection: null,
  packLoading: false,
  packError: null,
  packFillTimer: null,
  preUpdateRemove: null,
  lastSweepAt: 0,
  /** Forces the next preUpdate sweep regardless of throttle/camera delta. */
  sweepForced: true,
  lastSweepCamera: null,
};

/** Test-only: forget snapshot and live results so scenarios stay independent
 * despite the module-level singleton state. */
export function _resetAlprLayerForTest() {
  clearTimeout(state.packFillTimer);
  state.packFillTimer = null;
  state.pack = null;
  state.packLoading = false;
  state.packError = null;
  state.ambient = false;
  state.records = [];
  state.recordById = new Map();
  state.selectedId = null;
  state.lastUpdate = null;
  state.stale = false;
  state.saturated = false;
  state.status = 'idle';
  state.error = null;
  state.lastSweepAt = 0;
  state.sweepForced = true;
  state.lastSweepCamera = null;
}

/** @type {?Cesium.Color[]} Ambient point color per ALPR_AMBIENT_CLASSES index. */
let ambientColors = null;
function ambientColorFor(classIndex) {
  if (!ambientColors) {
    ambientColors = ALPR_AMBIENT_CLASSES.map((klass) => Cesium.Color
      .fromCssColorString(COLOR_BY_MANUFACTURER[klass] || DEFAULT_ACCENT)
      .withAlpha(0.9));
  }
  return ambientColors[classIndex] || ambientColors[0];
}

/** @param {object} record @returns {string} CSS accent for a camera record. */
export function alprAccent(record) {
  return COLOR_BY_MANUFACTURER[record?.manufacturerClass] || DEFAULT_ACCENT;
}

/**
 * Second label line for a camera: facing direction(s) first — the single most
 * operationally useful mapped fact — then the operator when one is tagged.
 * @param {object} record @returns {string[]} Non-empty detail lines.
 */
export function alprDetailLines(record) {
  const lines = [];
  if (Array.isArray(record?.directionsDeg) && record.directionsDeg.length) {
    lines.push(`FACING ${record.directionsDeg.map((deg) => compassLabel(deg)).join(' / ')}`);
  }
  if (record?.operator) lines.push(record.operator.toUpperCase());
  if (!lines.length) lines.push('LICENSE PLATE READER');
  return lines;
}

/**
 * Shared rendered-surface height for a camera anchor.
 * @param {{latitude:number, longitude:number}} record
 * @returns {number} Ellipsoidal render height in metres.
 */
export function alprSurfaceHeightM(record) {
  return floorAltitudeM(
    null,
    cachedGroundFloor(record?.latitude, record?.longitude),
  ) ?? 0;
}

/**
 * Whether a mapped camera belongs to the REQUESTED viewport.
 *
 * The proxy snaps the request bbox outward onto a shared cache grid, so a
 * response is a SUPERSET of what was asked for. Unlike installations, every
 * ALPR feature is point-scale in practice (the rare way/relation mapping is a
 * gantry a few metres long), so an exact centre containment test is correct
 * for all of them and cannot erase anything meaningful.
 * @param {{latitude:number, longitude:number}} record
 * @param {{south:number, west:number, north:number, east:number}} box
 * @returns {boolean}
 */
export function alprWithinViewport(record, box) {
  if (!record || !box) return false;
  return record.latitude >= box.south && record.latitude <= box.north
    && record.longitude >= box.west && record.longitude <= box.east;
}

/**
 * Whether a response was truncated at the upstream element cap. The proxy
 * states this outright; the count-vs-cap derivation is a safety net for any
 * payload that lost the flag.
 * @param {{saturated?: boolean, elements?: Array, elementCap?: number}} payload
 * @returns {boolean}
 */
export function alprResponseSaturated(payload) {
  if (typeof payload?.saturated === 'boolean') return payload.saturated;
  const cap = Number(payload?.elementCap);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return Array.isArray(payload?.elements) && payload.elements.length >= cap;
}

/**
 * Commit a status/error transition and buy the one frame it needs (see the
 * matching note in militaryInstallations.js — an idle governor would leave
 * the last healthy readout on screen).
 * @param {string} status @param {?string} error
 */
function setAlprStatus(status, error = null) {
  if (state.status === status && state.error === error) return;
  state.status = status;
  state.error = error;
  governorRequestRender('alpr-status');
}

function viewportBox(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle(viewer.scene.globe.ellipsoid);
  if (!rectangle) return null;
  const south = Cesium.Math.toDegrees(rectangle.south);
  const north = Cesium.Math.toDegrees(rectangle.north);
  const west = Cesium.Math.toDegrees(rectangle.west);
  const east = Cesium.Math.toDegrees(rectangle.east);
  // Cross-dateline/global views require a zoom before a bounded request.
  if (!Number.isFinite(south + north + west + east) || east <= west || north - south > MAX_VIEWPORT_DEGREES || east - west > MAX_VIEWPORT_DEGREES) return null;
  return { south, west, north, east };
}

function clearRendered() {
  if (state.dataSource?.entities) state.dataSource.entities.removeAll();
  removeEntityContextsForLayer(LAYER_ID);
}

/**
 * Fetch and decode the bundled worldwide snapshot once per session. Fail-soft:
 * a missing or corrupt pack degrades the wide view to the zoom-in guidance the
 * layer shipped with, never to a fault — the live tier is untouched.
 */
async function ensurePackLoaded() {
  if (state.pack || state.packLoading || state.packError) return;
  state.packLoading = true;
  governorRequestRender('alpr-ambient');
  try {
    const response = await fetch(PACK_URL);
    if (!response.ok) throw new Error(`ALPR snapshot HTTP ${response.status}`);
    state.pack = decodeAlprPack(await response.json());
    fillPackCollection(0);
  } catch (error) {
    state.packError = error?.message || 'ALPR snapshot unavailable';
  } finally {
    state.packLoading = false;
    // The regime that queued this load may have changed while it ran.
    syncAmbientPresentation();
  }
}

/**
 * Fill the ambient PointPrimitiveCollection in macrotask batches. ~147K
 * synchronous adds would freeze the frame; batching keeps every frame honest
 * and each batch buys its own render.
 * @param {number} startIndex First pack row of this batch.
 */
function fillPackCollection(startIndex) {
  clearTimeout(state.packFillTimer);
  state.packFillTimer = null;
  if (!state.pack || !state.packCollection) return;
  const { lonDeg, latDeg, vendorClass, count } = state.pack;
  const end = Math.min(count, startIndex + PACK_FILL_BATCH);
  for (let i = startIndex; i < end; i += 1) {
    state.packCollection.add({
      position: Cesium.Cartesian3.fromDegrees(lonDeg[i], latDeg[i]),
      pixelSize: AMBIENT_POINT_PX,
      color: ambientColorFor(vendorClass[i]),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  }
  // New primitives default to visible; make the next frame's sweep re-vet
  // the whole collection so a batch landing mid-rotation cannot bleed through.
  state.sweepForced = true;
  governorRequestRender('alpr-ambient');
  if (end < count) state.packFillTimer = setTimeout(() => fillPackCollection(end), 0);
}

/** Reused occluder; its cameraPosition is set before every sweep. */
const ambientOccluderScratch = new Cesium.EllipsoidalOccluder(
  Cesium.Ellipsoid.WGS84,
  new Cesium.Cartesian3(Cesium.Ellipsoid.WGS84.maximumRadius * 2, 0, 0),
);

/**
 * Horizon-cull the ambient points against the ellipsoid.
 *
 * The ambient tier keeps `disableDepthTestDistance: ∞` so height-0 points are
 * never buried under terrain/3D tiles — but that also switches off the one
 * test that would hide the far side of the planet, so the US camera blanket
 * shone straight through the globe from over the Atlantic (field report
 * 2026-08-29, screenshot). Depth can't answer while it's disabled; geometry
 * can: hide every point beyond the ellipsoid horizon explicitly.
 * @param {Cesium.PointPrimitiveCollection} collection Ambient points.
 * @param {Cesium.Cartesian3} cameraPosition World-space camera position.
 * @returns {number} How many points ended up hidden.
 */
export function _ambientOcclusionSweep(collection, cameraPosition, occluder = ambientOccluderScratch) {
  occluder.cameraPosition = cameraPosition;
  let hidden = 0;
  const length = collection.length;
  for (let i = 0; i < length; i += 1) {
    const point = collection.get(i);
    const visible = occluder.isPointVisible(point.position);
    if (point.show !== visible) point.show = visible;
    if (!visible) hidden += 1;
  }
  return hidden;
}

/**
 * Per-frame gate for the sweep: runs only while the collection is visible,
 * at most every AMBIENT_SWEEP_MIN_MS, and only when the camera actually moved
 * (or a fill/show transition forced it). Hooked on scene.preUpdate so the new
 * show flags land in the same frame; an idle scene renders no frames and pays
 * nothing.
 */
function ambientSweepListener() {
  const collection = state.packCollection;
  if (!collection || !collection.show || !collection.length) return;
  const cameraPosition = state.viewer?.camera?.positionWC;
  if (!cameraPosition) return;
  const now = Date.now();
  if (!state.sweepForced) {
    if (now - state.lastSweepAt < AMBIENT_SWEEP_MIN_MS) return;
    if (state.lastSweepCamera && Cesium.Cartesian3.equals(cameraPosition, state.lastSweepCamera)) return;
  }
  state.sweepForced = false;
  state.lastSweepAt = now;
  state.lastSweepCamera = Cesium.Cartesian3.clone(cameraPosition, state.lastSweepCamera || new Cesium.Cartesian3());
  _ambientOcclusionSweep(collection, cameraPosition);
}

/**
 * One authority for what the wide-view regime shows and reports. The bundled
 * points are also the fail-soft backdrop while the live tier is unavailable —
 * last-good mapped coverage beats an empty map, the serve-stale rule applied
 * to pixels.
 */
function syncAmbientPresentation() {
  if (state.packCollection) {
    const show = state.enabled && (state.ambient || state.status === 'unavailable');
    if (show && !state.packCollection.show) state.sweepForced = true;
    state.packCollection.show = show;
  }
  governorRequestRender('alpr-ambient');
  if (!state.ambient || !state.enabled) return;
  if (state.pack) {
    setAlprStatus('ready', null);
  } else if (!state.packLoading) {
    // Pack unavailable: fall back to the guidance this layer shipped with.
    setAlprStatus('zoom-in', 'Zoom in to load community-mapped ALPR cameras');
  }
}

/**
 * The records that get entities this paint: the first `MAX_RENDERED`, plus the
 * selected one when it falls outside that window, so every cohort item stays
 * selectable (same render-cap contract as installations).
 * @returns {Array<object>} Records to render this paint.
 */
function renderableRecords() {
  const rendered = state.records.slice(0, MAX_RENDERED);
  if (!state.selectedId) return rendered;
  if (rendered.some((record) => record.id === state.selectedId)) return rendered;
  const selected = state.recordById.get(state.selectedId);
  return selected ? [...rendered, selected] : rendered;
}

function renderRecords() {
  governorRequestRender('alpr-render');
  clearRendered();
  for (const record of renderableRecords()) {
    const accent = alprAccent(record);
    const color = Cesium.Color.fromCssColorString(accent);
    const surfaceHeightM = alprSurfaceHeightM(record);
    const displayPosition = Cesium.Cartesian3.fromDegrees(
      record.longitude,
      record.latitude,
      surfaceHeightM,
    );
    const entity = state.dataSource.entities.add({
      id: record.id,
      position: displayPosition,
      point: {
        pixelSize: record.id === state.selectedId ? 12 : 8,
        color: record.id === state.selectedId ? Cesium.Color.WHITE : color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevTrackedId = `alpr:${record.id}`;
    entity.gevDisplayPosition = () => displayPosition;
    entity.gevLabelModel = {
      title: record.name,
      details: alprDetailLines(record),
      accent,
    };
    registerEntityContext(entity, {
      id: record.id,
      layerId: LAYER_ID,
      layerName: 'ALPR Cameras',
      source: 'OpenStreetMap (DeFlock community mapping)',
      label: record.name,
      latitude: record.latitude,
      longitude: record.longitude,
      properties: {
        manufacturer: record.manufacturer,
        manufacturerClass: record.manufacturerClass,
        operator: record.operator,
        directionsDeg: record.directionsDeg,
        zone: record.zone,
        validation: record.validation,
        retrievedAt: record.retrievedAt,
      },
    });
  }
  const selectedEntity = state.selectedId
    ? state.dataSource.entities.getById(state.selectedId)
    : null;
  if (selectedEntity) selectEntityContext(selectedEntity);
  else state.selectedId = null;
}

/**
 * Second paint for floors that missed the bounded pre-render deadline — the
 * render → warm → re-render chain installations and FIRMS already use, with
 * the same was-cold-at-paint-time trigger (see warmInstallationFloors).
 * @param {Array<object>} records Records just rendered.
 * @returns {void}
 */
function warmAlprFloors(records) {
  const cold = records
    .filter((record) => cachedGroundFloor(record.latitude, record.longitude) == null)
    .map((record) => ({ lat: record.latitude, lon: record.longitude }));
  if (!cold.length) return;
  warmFireAnchorFloors(cold).then(() => {
    if (!state.enabled || !state.dataSource) return;
    if (!cold.some((point) => cachedGroundFloor(point.lat, point.lon) != null)) return;
    renderRecords();
  });
}

function selectRecord(id) {
  const record = state.recordById.get(id);
  if (!record || !state.dataSource) return false;
  state.selectedId = id;
  renderRecords();
  // renderRecords drops selectedId when the record produced no entity.
  return state.selectedId === id;
}

function installInteraction(viewer) {
  if (state.clickHandler) return;
  state.clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  state.clickHandler.setInputAction((click) => {
    if (!state.enabled) return;
    const picked = viewer.scene.pick(click.position);
    const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
    if (id && state.recordById.has(id)) selectRecord(id);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

/**
 * Backoff progression for the unavailable-state retry: 30 s, doubling to a
 * 240 s ceiling. Pure so the progression is pinnable without booting the layer.
 */
export function alprRetryDelayMs(prevDelayMs) {
  const RETRY_MIN_MS = 30000;
  const RETRY_CEIL_MS = 240000;
  if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
  return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
}

/**
 * 'Temporarily unavailable' must mean temporarily: fetches otherwise fire only
 * on enable and on camera moveEnd, so a parked camera whose first request died
 * would stay unavailable forever (same failure installations hit in the
 * field). While enabled and unavailable, retry on a 30 s → 240 s backoff; any
 * success, user-driven load, zoom-out, or disable cancels it.
 */
function scheduleUnavailableRetry() {
  if (!state.enabled) return;
  clearTimeout(state.retryTimer);
  state.retryDelayMs = alprRetryDelayMs(state.retryDelayMs);
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (state.enabled && !state.loading) loadCameras();
  }, state.retryDelayMs);
}

function clearUnavailableRetry({ resetBackoff = true } = {}) {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (resetBackoff) state.retryDelayMs = 0;
}

function scheduleLoad() {
  if (!state.enabled) return;
  // A user-driven load supersedes any pending retry; the load reschedules on
  // failure, so the backoff step is kept rather than reset.
  clearUnavailableRetry({ resetBackoff: false });
  clearTimeout(state.timer);
  state.timer = setTimeout(() => { loadCameras(); }, REQUEST_DEBOUNCE_MS);
}

async function loadCameras() {
  if (!state.enabled || !state.viewer) return;
  const box = viewportBox(state.viewer);
  if (!box) {
    // Wide view: the ambient regime renders the bundled worldwide snapshot
    // instead of asking Overpass for the impossible.
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    clearUnavailableRetry();
    state.ambient = true;
    ensurePackLoaded();
    syncAmbientPresentation();
    return;
  }
  state.ambient = false;
  syncAmbientPresentation();
  state.abort?.abort();
  const requestAbort = new AbortController();
  state.abort = requestAbort;
  state.loading = true;
  try {
    const fetchCameras = async (exact) => {
      const query = new URLSearchParams(Object.entries(box).map(([key, value]) => [key, value.toFixed(5)]));
      if (exact) query.set('exact', '1');
      const response = await fetch(`/api/alpr?${query}`, { signal: requestAbort.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || `ALPR feed HTTP ${response.status}`);
      return body;
    };

    let payload = await fetchCameras(false);
    // A SATURATED snapped tile was truncated upstream, so cameras from the
    // snap's extra ring may have crowded out ones actually on screen. Re-ask
    // for the exact viewport (separately keyed and cached) before rendering.
    let saturated = alprResponseSaturated(payload);
    if (saturated) {
      payload = await fetchCameras(true);
      saturated = alprResponseSaturated(payload);
    }
    const normalized = normalizeAlprCameras(payload, payload.retrievedAt || new Date().toISOString());
    // The proxy answers a bbox at least as large as the viewport; keep only
    // what was actually asked for so nothing off-screen reaches the map or the
    // "current viewport only" context claim.
    const records = normalized.records.filter((record) => alprWithinViewport(record, box));
    await resolveGroundFloorCellsBounded(records.map((record) => ({
      lat: record.latitude,
      lon: record.longitude,
    })));
    if (requestAbort.signal.aborted || state.abort !== requestAbort || !state.enabled) return;
    state.records = records;
    state.recordById = new Map(state.records.map((record) => [record.id, record]));
    state.lastUpdate = Date.now();
    state.stale = payload.status === 'stale';
    // Even the exact-viewport retry can saturate in a dense metro. Say so
    // rather than implying the view is completely surveyed.
    state.saturated = saturated;
    clearUnavailableRetry();
    setAlprStatus(
      state.records.length ? (state.stale ? 'stale' : 'ready') : 'empty',
      payload.status === 'stale'
        ? 'Serving cached ALPR mapping'
        : (saturated ? 'Too many mapped cameras in view to list them all' : null),
    );
    // A recovery from 'unavailable' must also retire the snapshot backdrop.
    syncAmbientPresentation();
    renderRecords();
    warmAlprFloors(state.records);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    setAlprStatus('unavailable', error?.message || 'ALPR camera context unavailable');
    scheduleUnavailableRetry();
    // Snapshot dots as the fail-soft backdrop while live retries.
    ensurePackLoaded();
    syncAmbientPresentation();
  } finally {
    // An older aborted request must not clear a newer request's busy state.
    if (state.abort === requestAbort) {
      state.abort = null;
      state.loading = false;
    }
  }
}

const alprLayer = {
  id: LAYER_ID,
  name: 'ALPR Cameras',
  icon: '⛶',
  source: 'OpenStreetMap (DeFlock)',
  updateInterval: 0,
  statsRefreshInterval: 1000,
  init(viewer) {
    state.viewer = viewer;
    state.dataSource = new Cesium.CustomDataSource('alpr');
    viewer.dataSources.add(state.dataSource);
    state.packCollection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    state.packCollection.show = false;
    state.preUpdateRemove = viewer.scene.preUpdate?.addEventListener(ambientSweepListener) ?? null;
    // A destroy/init cycle keeps the decoded pack; only the GL-side
    // collection needs refilling.
    if (state.pack) fillPackCollection(0);
    state.moveEndRemove = viewer.camera.moveEnd.addEventListener(scheduleLoad);
    installInteraction(viewer);
  },
  enable() {
    state.enabled = true;
    registerPickOwner(LAYER_ID, (id) => state.recordById.has(id));
    state.dataSource.show = true;
    syncAmbientPresentation();
    // DataLayerManager invokes update() immediately after enable(), which owns
    // the first fetch. Avoid racing it with a second aborting request here.
  },
  disable() {
    state.enabled = false;
    unregisterPickOwner(LAYER_ID);
    clearUnavailableRetry();
    clearTimeout(state.timer);
    state.abort?.abort();
    state.abort = null;
    state.loading = false;
    if (state.dataSource) state.dataSource.show = false;
    syncAmbientPresentation();
    clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
  },
  update() { return loadCameras(); },
  destroy(viewer) {
    this.disable();
    state.moveEndRemove?.();
    state.clickHandler?.destroy();
    state.clickHandler = null;
    clearTimeout(state.packFillTimer);
    state.packFillTimer = null;
    clearRendered();
    if (state.dataSource && viewer) viewer.dataSources.remove(state.dataSource, true);
    state.dataSource = null;
    if (state.packCollection && viewer) viewer.scene.primitives.remove(state.packCollection);
    state.packCollection = null;
    state.preUpdateRemove?.();
    state.preUpdateRemove = null;
    state.sweepForced = true;
    state.lastSweepCamera = null;
  },
  getNearby(center, rangeM, maxCount = 50) {
    if (!center) return [];
    const range = Number.isFinite(rangeM) ? rangeM : Infinity;
    const centerCartographic = Cesium.Cartographic.fromCartesian(center);
    if (!centerCartographic) return [];
    const nearby = [];
    const approximateLimit = Number.isFinite(range)
      ? range * 1.03 + DISTANCE_PREFILTER_MARGIN_M
      : Infinity;
    for (const record of state.records) {
      if (approximateSurfaceDistanceM(
        centerCartographic.latitude,
        centerCartographic.longitude,
        record.latitude,
        record.longitude,
      ) > approximateLimit) continue;
      // The awareness disk is projected onto the ground. Confirm candidates
      // with an exact ellipsoidal surface distance and reusable scratch state.
      distanceEndpointScratch.longitude = Cesium.Math.toRadians(record.longitude);
      distanceEndpointScratch.latitude = Cesium.Math.toRadians(record.latitude);
      distanceEndpointScratch.height = 0;
      distanceGeodesicScratch.setEndPoints(centerCartographic, distanceEndpointScratch);
      const distanceM = distanceGeodesicScratch.surfaceDistance;
      if (!Number.isFinite(distanceM) || distanceM > range) continue;
      nearby.push({
        ...record,
        position: Cesium.Cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
          alprSurfaceHeightM(record),
        ),
        distanceM,
      });
    }
    nearby.sort((a, b) => a.distanceM - b.distanceM);
    return nearby.slice(0, Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 50);
  },
  /**
   * Select and frame a mapped camera from another contextual UI.
   * @param {string} id Source-backed camera id.
   * @returns {boolean} True when an available camera was focused.
   */
  focusById(id) {
    const record = state.recordById.get(String(id));
    if (!record || !state.viewer) return false;
    // No camera flight without a real selection (see installations focusById).
    if (!selectRecord(record.id)) return false;
    state.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
          alprSurfaceHeightM(record),
        ),
        // Street furniture: frame the block, not the region.
        2500,
      ),
      { duration: 1.4 },
    );
    return true;
  },
  getStats() {
    const ambientCount = state.ambient && state.pack ? state.pack.count : 0;
    const loading = state.loading || (state.ambient && state.packLoading);
    return {
      count: ambientCount || state.records.length,
      lastUpdate: state.lastUpdate,
      stale: state.stale,
      saturated: state.saturated,
      error: state.error,
      status: state.status,
      loading,
      loadingLabel: loading
        ? (state.loading ? 'loading mapped ALPR cameras' : 'loading bundled ALPR snapshot')
        : '',
    };
  },
};

export default alprLayer;
