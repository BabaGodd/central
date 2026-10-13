# Central Corridor — GRDA Route Simulation

Accra → Sawla. Third of the Eastern / Western / Central Corridor series.

## Before deploying

1. Copy `config.local.example.js` to `config.local.js` and set
   `window.MAPBOX_TOKEN` to your Mapbox public token.
2. Keep `config.local.js` out of Git. Configure the same file as a deployment
   asset when deploying this static site.
3. Deploy the folder to Vercel (static site, no build step).

## Route notes

Fixed stop order (per request): **Accra → Boankra → Eduadin → Ejura →
Yeji → Bimbila → Yendi → Sawla**.

- Accra → Boankra and Ejura → Yeji → Bimbila → Yendi → Sawla run on the
  solid green "Central Corridor" line on the official GRDA reference map.
  Yendi → Sawla passes directly through Tamale, included as an unlabeled
  shape point (no marker, no HUD entry).
- Boankra → Eduadin → Ejura is **not confirmed** on the green line —
  Eduadin sits near a black dotted "Other Corridors" junction on the
  reference map, not the green Central Corridor. This stretch renders
  dashed, same convention as the earlier Sunyani→Sawla treatment. See the
  `ROUTE_SEGMENTS` array in `config.js` for the exact per-hop styling.
- Station coordinates are real-world town-centre coordinates (OpenStreetMap
  / Wikipedia), not surveyed rail platform coordinates, **except
  Eduadin** — no reliable geocoding source was found for it, so its
  coordinates in `config.js` are interpolated from its position on the
  reference map relative to Boankra and Kumasi. Treat it as approximate
  and replace it if you get a better source.
- Two unlabeled shape points (near Kibi and Nkawkaw) bend the Accra →
  Boankra stretch the way it bends on the reference map, rather than
  cutting a straight line.

## Files

- `index.html` / `style.css` — structure and HUD styling
- `config.js` — route, station, branding, camera, and map style config
- `config.local.example.js` — template for the ignored local Mapbox config
- `app.js` — Mapbox init, terrain, route rendering, native GL train layer, chase camera, HUD, controls
- `splash.css` / `splash.js` — loading screen
- `manifest.json` / `sw.js` / `icons/` — PWA
- `grda-logo.png` — cropped circular GRDA seal

The service worker caches static assets only. HTML, JavaScript, and CSS are
always fetched fresh, so code changes appear on reload instead of being served
from a stale application cache.

## Terrain and imagery startup

Before enabling playback, the app uses a separate, hidden Mapbox map to fit the
actual route geometry with corridor padding, load its raster imagery and DEM,
and verify elevation samples along the route and at every station. The visible
train and camera stay at route distance zero, the clock stays at zero, and
playback remains disabled until this base-coverage check and the visible
initial-view tile load have both settled.

The train model spans about 80 m behind its route point. To keep its
undercarriage from being clipped where that footprint crosses sloping terrain,
the model-only pitch and vertical clearance follow DEM samples across the
configured train footprint. This does not offset the GeoJSON train point from
the route.

The chase camera uses a low bird's-eye view, trails far enough behind to keep
the complete train model visible, and aims slightly ahead to show the upcoming
route. No atmosphere sky layer is added, avoiding the style's horizon fog.
Camera height, trailing distance, and look-ahead distance are tunable in
`CAMERA` in `config.js`.

This route's high-detail chase view would require thousands of separate
viewports to preload every close-up tile before playback. That is too slow and
can exceed Mapbox request limits, so the app deliberately uses a bounded
route-wide base preflight instead. Close-up terrain and imagery tiles stream
through Mapbox GL JS's normal source/cache behavior during travel; the route
panel discloses this. It does not claim that all high-zoom tiles are resident
before playback or that Mapbox/browser caches retain them for the whole
journey/offline.

The route-wide check is bounded by `PRELOAD` in `config.js`. A failed tile
request, unavailable route elevation sample, or stalled map leaves playback
disabled and presents an explicit retry state.
