# God's Eye View

A real-time geospatial intelligence console that runs in the browser: a photorealistic 3D globe rendering live public data feeds — aircraft, ships, satellites, earthquakes, traffic, and public cameras — on top of Google Photorealistic 3D Tiles.

This is a fork of [God&#39;s Eye View](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal Sidhu. It differs from the upstream project in two deliberate ways:

- **The voice-control / OpenAI subsystem is removed entirely.** No OpenAI key is used or supported; the app has no AI runtime dependency.
- **Rendering defaults are tuned for modest hardware** (MSAA off, coarser 3D-tile LOD cutoff).

## Overview

Most open-source intelligence work happens across a pile of browser tabs. The signals are abundant; the interface is the bottleneck. This project turns those signals into a single place: the world is already broadcasting — flight transponders, ship beacons, orbital elements, seismographs, public cameras — and this renders it on a 3D Earth in real time, from public sources, with inspectable code.

The live layers are grounded in public feeds: an aircraft on screen is reporting real telemetry, a camera is installed at a published location, and the ISS position is propagated from current orbital elements. The client deliberately renders flights one polling interval behind real time so it can interpolate smoothly. Where an experience is modeled rather than live, it is labeled: keyless traffic is a marked simulation, camera poses are estimated priors until calibrated, and launch ascent playback is marked `RECONSTRUCTED ESTIMATE`. Each layer keeps its source and freshness state visible, including partial, delayed, simulated, and unavailable states.

## Features

- **Click-to-track**: select any aircraft, vessel, or satellite; the camera locks on, draws a fading trail, and surfaces live telemetry. A tracked fire or vessel can hand off to the nearest public camera.
- **Cockpit view**: ride inside a tracked flight with terrain held under the aircraft, a briefing strip (nearby signals, regional headlines, local weather), and an opt-in volumetric cloud mode driven by real observations.
- **Contacts roster**: a 250 km roster of everything near the tracked target; step through live aircraft and enter any cockpit.
- **3D aircraft models**: per-class models (787, ATR-72, Citation, Bell 206, MQ-9); a tracked contact swaps from glyph to model as the camera closes in.
- **Sensor modes**: GLSL post-processing over the globe — night-vision and thermal — switchable with keys `1`–`3`.
- **Detection overlay**: screen-space bounding boxes and identifiers on objects in view, with adjustable density.
- **Telemetry HUD**: full-screen overlay of real camera-derived readouts (MGRS, GSD, off-nadir angle, sun elevation, UTC, semantic summary) in three layout variants.
- **Track history**: select a military contact and its last ~24 h of real trace history resolves as stacked 3D loops.
- **Global context**: stage a full situational picture with one control and return to the exact prior view on exit.
- **Share links**: camera, style, layers, and one tracked target serialize into a URL; a live target link is a handoff, not a bookmark.
- **Map stack**: Google Photorealistic 3D, Bing aerial (via Cesium ion), and OSM, switchable at runtime.

## Data layers

Thirteen live layers. Ten require no key, account, or signup.

| Layer                | Description                                                                                                                               | Source                    | Key                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| Map stack            | Google Photorealistic 3D, Bing aerial, OSM                                                                                                | Google / Cesium ion / OSM | Google required (metered); ion optional for Bing; OSM none |
| Live flights         | Thousands of live aircraft with route history                                                                                             | OpenSky + adsb.lol        | None (optional free key raises polling credits)            |
| Military flights     | ADS-B military traffic                                                                                                                    | adsb.lol                  | None                                                       |
| Live vessels         | Thousands of ships worldwide                                                                                                              | AISStream                 | Free key                                                   |
| Satellites           | ~840-object core catalog, color-coded by class; a DENSE option loads the full Starlink shell                                              | CelesTrak                 | None                                                       |
| Earthquakes          | Global seismic activity, trailing 24 h                                                                                                    | USGS                      | None                                                       |
| Traffic              | Live congestion driving per-vehicle flow below ~8 km altitude; keyless fallback is a labeled simulation                                   | TomTom + OSM              | Free key for live data                                     |
| CCTV                 | ~800 public cameras projected into the 3D scene (Austin, Caltrans, London TfL); poses are estimated priors calibrated by dragging a gizmo | City APIs                 | None                                                       |
| Radio                | Geolocated world radio (up to 750 stations) with an analog tuner; each station is a real broadcaster the globe flies to                   | Radio Browser             | None                                                       |
| Bikeshare            | Live station availability                                                                                                                 | GBFS                      | None                                                       |
| Active fires         | Live NASA FIRMS detections, trailing 24 h                                                                                                 | NASA FIRMS                | Free key                                                   |
| Space missions       | Rolling 30-day launches with payload, stage, and recovery detail; scrubbable ascent replay                                                | Launch Library 2          | None (optional token raises allowance)                     |
| Mapped installations | Viewport-bounded military-site context from community mapping; incomplete by nature and labeled as such                                   | OpenStreetMap             | None                                                       |

Bundled static datasets: datacenters (4,351), dams (704), and submarine cables (712), with per-folder provenance in `src/data/local_data/`.

## Requirements

- Node.js 24.14.x or 26.x (enforced by `package.json`)
- A modern browser with WebGL 2
- A Google Maps API key with the Map Tiles API enabled (the only required key)

## Quick start

1. Copy `.env.example` to `.env` and set `GOOGLE_MAPS_API_KEY`.
2. Install and run:

```bash
npm install
npm run dev -- --host localhost --port 4173
```

3. Open `http://localhost:4173` and enable layers from the left panel.

The dev server binds to localhost by default, so API keys stay on your machine. On macOS, `./scripts/dev-fresh.sh` clears the Vite cache and pulls keys from the Keychain (service names are documented in `.env.example`).

Keyboard: `1`–`3` sensor modes · `H` HUD · `D` detection overlay · `C` cockpit · `Esc` exit.

### A short tour

1. Enable **Flights** and click an aircraft: the camera locks on and its telemetry card comes up. Press `C` to ride in the cockpit; use **Contacts** to jump between nearby aircraft.
2. Search for a busy airport and descend to the taxiways with 3D models on — grounded contacts and taxi trails resolve in real time.
3. Enable **CCTV** over Austin, London, or California. Feeds project into the 3D scene rather than embedding as flat video; the VIEWSHED mode draws each camera's estimated coverage volume.
4. Enable **Traffic** and dive below ~8 km, then use NEAREST in the CCTV panel to view a jam through the camera pointed at it.
5. Enable **Satellites** and click the ISS to ride along at orbital distance.
6. Open **Space Missions**, pick a launch from the last 30 days, and scrub the reconstructed ascent from countdown to orbit.

## API keys and cost

| Key                    | Purpose                                               | Cost               | Where                                                                            |
| ---------------------- | ----------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| Google Maps (required) | Photorealistic 3D planet, place search                | Metered; see below | [Google Cloud Console](https://console.cloud.google.com/)                         |
| AISStream              | Live vessels                                          | Free               | [aisstream.io](https://aisstream.io)                                              |
| NASA FIRMS             | Active fires                                          | Free               | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/map_key/) |
| TomTom                 | Live traffic instead of simulation                    | Free tier          | [developer.tomtom.com](https://developer.tomtom.com)                              |
| Cesium ion             | Bing imagery map stacks (public`assets:read` token) | Free tier          | [cesium.com/ion](https://cesium.com/ion)                                          |
| OpenSky                | More flight-polling credits (anonymous works without) | Free               | [opensky-network.org](https://opensky-network.org)                                |
| Launch Library 2       | Higher space-missions request allowance               | Free               | [thespacedevs.com](https://thespacedevs.com)                                      |

Keys go in `.env` (see `.env.example`) or the macOS Keychain. Only the Google Maps key and Cesium ion token are exposed to the browser, by design; restrict both at the provider. All other keys are brokered server-side and never reach the client.

### Google billing

Google 3D Tiles billing counts root tileset requests: one request buys up to three hours of tile rendering, and the first 1,000 per month are currently free (then roughly $6 per 1,000, US pricing — [check the current page](https://developers.google.com/maps/billing-and-pricing/pricing)). A solo user rarely leaves the free tier. The key is also used for the Geocoding API (the search box), and optionally for Street View Static (CCTV frame fallback) and Places Text Search (search recovery and installations enrichment).

To put a hard ceiling on spend rather than relying on alerts:

1. **API-restrict the key** in Cloud Console (Credentials → key → API restrictions) to the Map Tiles API and Geocoding API. The Street View and Places paths degrade gracefully when blocked.
2. **Set per-API quota caps** (APIs & Services → Quotas). When a quota trips, calls fail instead of billing.
3. **Add a budget alert** as an early-warning layer. Alerts notify; only quotas stop spend.

Provider prices and allowances change; verify against the linked pricing pages before relying on an estimate.

## Architecture

Vanilla JavaScript, CesiumJS, and Vite — no framework. Google Photorealistic 3D Tiles provide the planet.

```
src/
├── main.js                 # Bootstrap: Google 3D tiles, layer registration
├── ui.js                   # Runtime UI — panels, HUD, styles, control facade
├── hud.js                  # Intelligence HUD
├── mapStackController.js   # Google 3D / Bing / OSM switching
├── iconOrientation.js      # Screen-projected world-space headings + horizon cull
├── renderGovernor.js       # Idle render governor (requestRenderMode management)
├── data/                   # One module per layer + management + context store
│   └── local_data/         # Bundled datasets (per-folder provenance)
└── scenes/                 # Scripted scene director
```

Engineering notes:

- **World-stable icons.** Aircraft and ships point along their true real-world heading at every camera angle via per-frame screen-space course projection.
- **Smooth motion from choppy data.** Live feeds arrive every 15–30 s; the globe renders one interval behind real time and interpolates between known fixes, with dead reckoning filling gaps.
- **Correct satellite propagation.** SGP4 with orbit rings locked to their satellites via GMST realignment.
- **Real vertical datum.** Entity heights are geoid-aware and sampled against the rendered terrain mesh, so aircraft park on aprons and cameras stand on street corners.
- **Budget-governed proxies.** Paid feeds run behind cached, budget-governed server-side proxies: an OpenSky credit governor, a TomTom daily tile budget, disk-cached TLEs.
- **Idle render governor.** The render loop stops when nothing animates and resumes on camera input, tile loads, or explicit render requests, keeping idle GPU/CPU cost near zero.

See [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md) for the authoritative runtime reference and [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) for a measured baseline.

### Performance tuning

This fork ships with MSAA disabled and the Google tileset's `maximumScreenSpaceError` raised from 16 to 24 (`src/main.js`) — a large GPU/memory cut for a small sharpness cost. If it's still heavy, lower `viewer.resolutionScale`; if you have GPU headroom to spare, restore `msaaSamples: 4` and `maximumScreenSpaceError: 16`. The vessel render cap (`VITE_AIS_LIVE_MAX_ROWS`) and the detection-overlay density slider are the other significant load levers.

## Sharing an instance

By default the server binds to localhost and nobody else can reach it. To share on a LAN, opt in explicitly (`npm run dev -- --host 0.0.0.0`), understanding that a LAN-visible server brokers your configured API keys to anyone who can reach it. Set the per-IP throttle (`GEV_RATELIMIT_GOOGLE_PER_MIN`, see `.env.example`) and provider-side budget caps first; the throttle is an app-level guard, not a billing cap. Full threat model in [SECURITY.md](SECURITY.md).

## Scope and responsible use

This project runs on public data, clear sources, and local-first execution. It models events, assets, infrastructure, and systems — aircraft, vessels, satellites, fires, cameras, cities. It does not build features for named-person search, face recognition, or tracking individuals, and pull requests that cross that line won't be merged.

> [!IMPORTANT]
> God's Eye View is an exploratory visualization of public and third-party data.
> Data may be delayed, incomplete, modeled, inferred, or wrong. Do not use it
> for flight or maritime navigation, emergency response, medical or health
> decisions, investment decisions, or other safety-critical or operational
> purposes. Verify important information with authoritative sources.

## License

Released under the [MIT License](LICENSE). Original project by [Bilawal Sidhu](https://github.com/bilawalsidhu). Bundled and live datasets carry their own terms — see [DATA_SOURCES.md](DATA_SOURCES.md). Security model: [SECURITY.md](SECURITY.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Testing: [TESTING.md](TESTING.md).
