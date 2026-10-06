/* ============================================================
   CENTRAL CORRIDOR — CONFIG
   Ghana Railway Development Authority (GRDA)
   Route: Accra → Boankra → Eduadin → Ejura → Yeji → Bimbila →
          Yendi → Sawla (stop order and order only — fixed per
          request; do not reorder or add/remove stops).

   Coordinates for Accra, Boankra, Ejura, Yeji, Bimbila, Yendi and
   Sawla are real-world town-centre coordinates (OpenStreetMap /
   Wikipedia geodata). Eduadin's coordinates are an ESTIMATE — no
   reliable geocoding source was found for it, so its position was
   interpolated from where it sits on the reference map relative to
   Boankra and Kumasi. Treat it as approximate.

   Per-segment styling (see ROUTE_SEGMENTS below) reflects what's
   actually traceable on the official map: Accra→Boankra and
   Ejura→Yeji→Bimbila→Yendi→Sawla run on the solid green "Central
   Corridor" line (Yendi→Sawla passes directly through Tamale,
   included as an unlabeled shape point). Boankra→Eduadin→Ejura is
   NOT confirmed on the green line — Eduadin sits near a black
   dotted "Other Corridors" junction — so that stretch renders as
   the dashed "linked corridor" style, same convention as before.
   ============================================================ */

// ---- Mapbox ----
// Public token only (starts with "pk."). Replace before deploying.
// If GitHub's secret scanner flags this on push, mark it a false
// positive, then restrict the token to your deployment domain at
// account.mapbox.com.
const MAPBOX_TOKEN = window.MAPBOX_TOKEN || '';

// ---- Branding ----
const BRAND = {
  name: 'GRDA',
  fullName: 'Ghana Railway Development Authority',
  logo: 'grda-logo.png',
  projectTitle: 'Central Corridor',
  projectSubtitle: 'Accra — Sawla',
};

// ---- Stations (fixed order, per request) ----
const STATIONS = [
  { id: 'accra',   name: 'Accra',   lat: 5.5600, lng: -0.2057, origin: true },
  { id: 'boankra', name: 'Boankra', lat: 6.6944, lng: -1.4028 },
  { id: 'eduadin', name: 'Eduadin', lat: 6.6660, lng: -1.4800 }, // estimated, see note above
  { id: 'ejura',   name: 'Ejura',   lat: 7.3830, lng: -1.3670 },
  { id: 'yeji',    name: 'Yeji',    lat: 8.2170, lng: -0.6500 },
  { id: 'bimbila', name: 'Bimbila', lat: 8.8572, lng: -0.0567 },
  { id: 'yendi',   name: 'Yendi',   lat: 9.4325, lng: -0.0042 },
  { id: 'sawla',   name: 'Sawla',   lat: 9.2830, lng: -2.4170, destination: true },
];

// ---- Unlabeled shape points ----
// Approximate waypoints that trace the map's line curvature between
// stations. These are NOT stops — no marker, no label, no HUD entry.
// after: the station id this shape point follows.
const SHAPE_POINTS = [
  // Accra -> Boankra: the green line arcs north past the Kibi / Nkawkaw
  // area before bending west into Boankra, rather than running straight.
  { after: 'accra', lat: 6.167, lng: -0.550 }, // near Kibi
  { after: 'accra', lat: 6.550, lng: -0.767 }, // near Nkawkaw
  // Yendi -> Sawla: the green line runs directly through Tamale.
  { after: 'yendi', lat: 9.4075, lng: -0.8533 }, // Tamale
];

// ---- Route segment styling ----
// Styled per-hop (not per-station), since this route touches the
// green Central Corridor line, leaves it, then rejoins it.
// 'central' = solid, on the map's green Central Corridor line.
// 'linked'  = dashed, NOT confirmed on the green line (see note above).
const ROUTE_SEGMENTS = [
  { from: 'accra',   to: 'boankra', style: 'central' },
  { from: 'boankra', to: 'eduadin', style: 'linked' },
  { from: 'eduadin', to: 'ejura',   style: 'linked' },
  { from: 'ejura',   to: 'yeji',    style: 'central' },
  { from: 'yeji',    to: 'bimbila', style: 'central' },
  { from: 'bimbila', to: 'yendi',   style: 'central' },
  { from: 'yendi',   to: 'sawla',   style: 'central' },
];

const CORRIDOR_STYLE = {
  central: {
    color: '#fcd116',       // gold, Ghana flag accent
    glowColor: '#fcd116',
    dashArray: null,        // solid — matches the map's solid green Central Corridor
  },
  linked: {
    color: '#fcd116',
    glowColor: '#fcd116',
    dashArray: [2, 2],       // dashed — this stretch is on "Other Corridors" on the map, not green
  },
};

// ---- 3D train model ----
// Reused as-is from the Eastern Corridor project. Place
// Ghana_Freight_Train.glb in the same folder as index.html.
const MODEL = {
  uri: 'Ghana_Freight_Train.glb',
  scale: [1, 1, 1], // built in real-world meters, so no scaling needed
  // Lateral offset to recenter the model ON the route line (its own
  // origin isn't centered on its width) — a few meters. Starting
  // value per the Eastern Corridor notes — confirm visually, adjust
  // if it drifts the wrong way (flip sign, or swap +90/-90 below).
  lateralOffsetM: 1.7,
  // Yaw correction added on top of the real travel bearing. Mapbox's
  // model source faces a model's local +Z axis toward world SOUTH at
  // zero yaw, not north — so raw compass bearing is not plug-and-play.
  // UNCONFIRMED — start at 0, then correct in 90° steps by watching
  // whether the train appears to drive forward, backward, or sideways
  // relative to the track. This needs a visual test; don't trust it
  // blindly.
  bearingOffsetDeg: 0,
};

// ---- Camera ----
const CAMERA = {
  chaseBehindKm: 0.16,        // keep enough distance to frame the full 80m train
  heightAboveGroundM: 50,     // raise the chase view to show the train's full length
  // Sideways offset from a pure rear-chase position, so the shot shows
  // the train's side/length plus surrounding terrain rather than just
  // staring straight down the track at its back end. ~70m sideways at
  // ~160m behind gives a three-quarter angle. Tune by feel.
  sideOffsetKm: 0.07,
  cameraSmoothing: 0.08,      // Eastern Corridor's confirmed-good value (not yet wired in — see app.js note)
  pitch: 68,
};

// ---- Journey ----
// Speed is fixed at 0.1446 km/s (144.6 m/s) — the Eastern Corridor's
// confirmed-good chase-camera speed. Duration is DERIVED from that
// speed and this route's actual distance (861.64 km, computed from
// the real route geometry below), per the formula:
//   totalDurationSeconds = totalDistanceKm / 0.1446
// Do not hand-tune this number — if the route geometry changes, this
// must be recalculated from the new distance, not adjusted by feel.
const JOURNEY = {
  speedKmPerSecond: 0.1446,
  totalDurationSeconds: 5959, // 861.64 / 0.1446 = 5958.8s ≈ 99:19
};

// ---- Map style ----
const MAP_STYLE = 'mapbox://styles/mapbox/satellite-streets-v12';
const TERRAIN_SOURCE_URL = 'mapbox://mapbox.mapbox-terrain-dem-v1';