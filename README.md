# Central Corridor — GRDA Route Simulation

Accra → Sawla. Third of the Eastern / Western / Central Corridor series.

## Before deploying

1. Open `config.js` and replace `MAPBOX_TOKEN` with your real **public**
   Mapbox token (starts with `pk.`).
2. Push to GitHub. If the secret scanner flags the token, mark it a false
   positive (it's public), then restrict it to your deployment domain at
   account.mapbox.com.
3. Deploy the folder to Vercel as-is (static site, no build step).

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
- `config.js` — all route, station, branding and camera config
- `app.js` — Mapbox init, terrain, route rendering, native GL train layer, chase camera, HUD, controls
- `splash.css` / `splash.js` — loading screen
- `manifest.json` / `sw.js` / `icons/` — PWA
- `grda-logo.png` — cropped circular GRDA seal
