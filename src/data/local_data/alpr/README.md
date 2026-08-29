# ALPR Cameras (bundled snapshot)

Worldwide OpenStreetMap extract of automatic-license-plate-reader cameras,
community-mapped predominantly through the [DeFlock](https://deflock.org)
project's tagging schema, bundled for the ALPR layer's globe-scale ambient
tier. The layer's live `/api/alpr` tier supersedes this snapshot inside a
zoomed-in viewport.

- Source: OpenStreetMap contributors (Overpass API)
- License: Open Database License (ODbL) 1.0 — https://www.openstreetmap.org/copyright
- Feature count: 147,674 (147,531 nodes, 140 ways, 3 relations; 0 malformed/duplicate rows dropped)
- Vendors table: 214 · Operators table: 2163
- OSM data timestamp: 2026-08-29T17:34:21Z
- Extracted: 2026-08-29T17:38:53.647Z from a pre-downloaded Overpass response (alpr-world.json)
- Query: `[out:json][timeout:600][maxsize:1073741824];nwr["surveillance:type"="ALPR"];out center qt;`
- Runtime file: `cameras.json` (format: `src/data/alprPack.js`, version 1)
- Rebuild: `node scripts/build-alpr-snapshot.mjs`

Deterministic transform: coordinates rounded to 5 decimals (~1.1 m); kept tags
limited to manufacturer (brand fallback), operator, and parsed facing
direction(s); rows sorted by OSM id. The public-release snapshot drops any
kept value containing an email or phone identifier (the same rule as the
datacenters/dams snapshots) and caps values at 80 chars.

Mapped presence is a community report, not an operator disclosure; coverage is
incomplete by nature, and the absence of a marker is never evidence a road is
unwatched. This derived database is distributed under ODbL 1.0 with the
required "© OpenStreetMap contributors" attribution.
