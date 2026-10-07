/* ============================================================
   CENTRAL CORRIDOR — APP
   Ghana Railway Development Authority
   ============================================================ */

mapboxgl.accessToken = MAPBOX_TOKEN;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const map = new mapboxgl.Map({
  container: 'map',
  style: MAP_STYLE,
  center: [STATIONS[0].lng, STATIONS[0].lat],
  zoom: 14,
  pitch: CAMERA.pitch,
  bearing: 0,
  antialias: true,
});

// ---------------------------------------------------------------
// Route construction: stations + unlabeled shape points, smoothed
// ---------------------------------------------------------------
function buildRawCoordinates() {
  const coords = [];
  STATIONS.forEach((s) => {
    coords.push([s.lng, s.lat]);
    SHAPE_POINTS
      .filter((p) => p.after === s.id)
      .forEach((p) => coords.push([p.lng, p.lat]));
  });
  return coords;
}

const rawLine = turf.lineString(buildRawCoordinates());
const fullRoute = turf.bezierSpline(rawLine, { sharpness: 0.82, resolution: 12000 });
const totalDistanceKm = turf.length(fullRoute, { units: 'kilometers' });

// Distance-along-route for every station (for HUD + segment slicing)
const stationById = {};
STATIONS.forEach((s) => {
  const nearest = turf.nearestPointOnLine(fullRoute, turf.point([s.lng, s.lat]), { units: 'kilometers' });
  s.distanceKm = nearest.properties.location;
  stationById[s.id] = s;
});

// Slice the route into one GeoJSON line per ROUTE_SEGMENTS entry, each
// carrying its own 'central' (solid) or 'linked' (dashed) style —
// the corridor touches the green line, leaves it, then rejoins it.
const routeSegmentLines = ROUTE_SEGMENTS.map((seg) => {
  const from = stationById[seg.from];
  const to = stationById[seg.to];
  const fromPt = turf.along(fullRoute, from.distanceKm, { units: 'kilometers' });
  const toPt = turf.along(fullRoute, to.distanceKm, { units: 'kilometers' });
  return {
    id: `${seg.from}-${seg.to}`,
    style: seg.style,
    line: turf.lineSlice(fromPt, toPt, fullRoute),
  };
});

// ---------------------------------------------------------------
// Elevation helper
// ---------------------------------------------------------------
const routeElevationCache = new Map();
let lastKnownCameraElevation = 0;
let lastKnownRouteElevation = null;
let trainTerrainProfileActive = false;

function getElevation(lngLat) {
  const el = map.queryTerrainElevation(lngLat, { exaggerated: false });
  if (Number.isFinite(el)) {
    lastKnownCameraElevation = el;
    return el;
  }
  return lastKnownCameraElevation;
}

function getRouteElevationBucket(bucket) {
  const cached = routeElevationCache.get(bucket);
  if (Number.isFinite(cached)) return cached;

  const sampleDistanceKm = bucket / 100;
  const sample = turf.along(fullRoute, sampleDistanceKm, { units: 'kilometers' }).geometry.coordinates;
  const elevation = map.queryTerrainElevation(sample, { exaggerated: false });
  if (Number.isFinite(elevation)) {
    routeElevationCache.set(bucket, elevation);
    lastKnownRouteElevation = elevation;
    return elevation;
  }

  for (let offset = 1; offset <= 10; offset++) {
    const before = routeElevationCache.get(bucket - offset);
    const after = routeElevationCache.get(bucket + offset);
    if (Number.isFinite(before) && Number.isFinite(after)) return (before + after) / 2;
    if (Number.isFinite(before)) return before;
    if (Number.isFinite(after)) return after;
  }

  return lastKnownRouteElevation;
}

function getRouteElevation(distanceKm) {
  const clampedDistance = Math.max(0, Math.min(distanceKm, totalDistanceKm));
  const bucketPosition = clampedDistance * 100;
  const lowerBucket = Math.floor(bucketPosition);
  const upperBucket = Math.ceil(bucketPosition);
  const lowerElevation = getRouteElevationBucket(lowerBucket);
  if (lowerBucket === upperBucket) return lowerElevation;

  const upperElevation = getRouteElevationBucket(upperBucket);
  if (Number.isFinite(lowerElevation) && Number.isFinite(upperElevation)) {
    const fraction = bucketPosition - lowerBucket;
    return lowerElevation + (upperElevation - lowerElevation) * fraction;
  }
  return Number.isFinite(lowerElevation) ? lowerElevation : upperElevation;
}

function getTrainGroundElevation(distanceKm) {
  // Sample the full train footprint so small DEM bumps cannot clip its body.
  const halfLengthKm = 0.04;
  const sampleOffsetsKm = [-halfLengthKm, -halfLengthKm / 2, 0, halfLengthKm / 2, halfLengthKm];
  const elevations = sampleOffsetsKm
    .map((offset) => getRouteElevation(distanceKm + offset))
    .filter(Number.isFinite);
  if (!elevations.length) return null;
  const highestElevation = Math.max(...elevations);
  return highestElevation + 0.5;
}

// ---------------------------------------------------------------
// Chase camera — positions the free camera behind and above a target,
// shared by the initial framing shot and the per-frame playback chase.
// ---------------------------------------------------------------
function positionChaseCamera(camLngLat, trainLngLat) {
  const camAltitude = getElevation(camLngLat) + CAMERA.heightAboveGroundM;
  const trainAltitude = getElevation(trainLngLat) + 2; // small lift so it doesn't clip into terrain

  const camMerc = mapboxgl.MercatorCoordinate.fromLngLat(camLngLat, camAltitude);

  const freeCam = map.getFreeCameraOptions();
  freeCam.position = camMerc;
  // lookAtPoint's real signature is (lngLat, upVector?, altitude?) — it
  // does NOT take a MercatorCoordinate. Passing the plain coordinate
  // plus the real altitude is what actually aims it at the train's true
  // (terrain-elevated) position instead of sea level.
  freeCam.lookAtPoint(trainLngLat, [0, 0, 1], trainAltitude);
  map.setFreeCameraOptions(freeCam);
}

// Heading (compass degrees, 0 = north) of travel at a given distance
// along the route, from a short lookahead sample.
function headingAt(distanceKm) {
  const aheadKm = Math.min(distanceKm + 0.05, totalDistanceKm);
  const behindKm = Math.max(distanceKm - 0.05, 0);
  const a = turf.along(fullRoute, behindKm, { units: 'kilometers' }).geometry.coordinates;
  const b = turf.along(fullRoute, aheadKm, { units: 'kilometers' }).geometry.coordinates;
  return turf.bearing(a, b);
}

// Chase camera point: behind the train along the route, offset
// sideways from the direct chase line so the shot shows the train's
// side/length and surrounding terrain, not just its back end.
function chaseCameraPoint(trainLngLat, headingDeg) {
  const behindPt = turf.destination(trainLngLat, CAMERA.chaseBehindKm, headingDeg + 180, { units: 'kilometers' });
  const sidePt = turf.destination(behindPt, CAMERA.sideOffsetKm, headingDeg + 90, { units: 'kilometers' });
  return sidePt.geometry.coordinates;
}

// Lateral recentering offset for the model's own position (its mesh
// origin isn't centered on its width — see config.js MODEL notes).
function centeredModelPosition(trainLngLat, headingDeg) {
  return turf.destination(trainLngLat, MODEL.lateralOffsetM / 1000, headingDeg + 90, { units: 'kilometers' }).geometry.coordinates;
}

// ---------------------------------------------------------------
// The native 3D model is the only train visual; the old canvas
// billboard and custom WebGL layer have been removed.
// ---------------------------------------------------------------


// ---------------------------------------------------------------
// Map initialization
// ---------------------------------------------------------------
let mapInitialized = false;

function initializeMap() {
  if (mapInitialized) return;
  mapInitialized = true;

  try {
  // Terrain
  map.addSource('mapbox-dem', {
    type: 'raster-dem',
    url: TERRAIN_SOURCE_URL,
    tileSize: 512,
    maxzoom: 14,
  });
  map.setTerrain({ source: 'mapbox-dem', exaggeration: 1 });

  map.addLayer({
    id: 'sky-layer',
    type: 'sky',
    paint: { 'sky-type': 'atmosphere', 'sky-atmosphere-sun-intensity': 8 },
  });

  // Route lines — one glow+line layer pair per segment, styled solid
  // ('central', on the green Central Corridor line) or dashed
  // ('linked', not confirmed on the green line). See config.js notes.
  routeSegmentLines.forEach((seg) => {
    const style = CORRIDOR_STYLE[seg.style];
    map.addSource(`route-${seg.id}`, { type: 'geojson', data: seg.line });
    map.addLayer({
      id: `route-${seg.id}-glow`,
      type: 'line',
      source: `route-${seg.id}`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': style.glowColor,
        'line-width': seg.style === 'central' ? 7 : 6,
        'line-blur': seg.style === 'central' ? 4 : 3,
        'line-opacity': seg.style === 'central' ? 0.35 : 0.22,
      },
    });
    const lineLayer = {
      id: `route-${seg.id}-line`,
      type: 'line',
      source: `route-${seg.id}`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': style.color,
        'line-width': seg.style === 'central' ? 2.4 : 2,
      },
    };
    if (style.dashArray) {
      lineLayer.paint['line-dasharray'] = style.dashArray;
      lineLayer.paint['line-opacity'] = 0.85;
    }
    map.addLayer(lineLayer);
  });

  // Stations
  const stationFeatures = STATIONS.map((s) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    properties: { name: s.name },
  }));
  map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: stationFeatures } });

  map.addLayer({
    id: 'station-rings',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': 5,
      'circle-color': '#071018',
      'circle-stroke-color': '#fcd116',
      'circle-stroke-width': 1.6,
    },
  });
  map.addLayer({
    id: 'station-labels',
    type: 'symbol',
    source: 'stations',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
      'text-size': 11,
      'text-offset': [0, 1.3],
      'text-anchor': 'top',
      'text-letter-spacing': 0.05,
    },
    paint: {
      'text-color': '#f4f7f6',
      'text-halo-color': '#071018',
      'text-halo-width': 1.4,
    },
  });

  // ---------------------------------------------------------------
  // Train — one native 3D model, updated along the route during playback.
  // ---------------------------------------------------------------
  const initialHeading = headingAt(0);
  map.addSource('train-model-source', {
    type: 'model',
    models: {
      'ghana-freight-train': {
        uri: MODEL.uri,
        position: centeredModelPosition([STATIONS[0].lng, STATIONS[0].lat], initialHeading),
        // No roll: this model's own bounding box (Y=height 5.1m, Z=length
        // 80.1m) confirms it's already flat at identity rotation, since
        // Mapbox's model source maps local Y to world "up" by default.
        // The 90° roll from the Eastern Corridor notes was for a model
        // with a different local axis layout — applying it here was
        // exactly what tipped this train upright.
        orientation: [0, 0, initialHeading + MODEL.bearingOffsetDeg],
      },
    },
  });
  map.addLayer({
    id: 'train-model-layer',
    type: 'model',
    source: 'train-model-source',
    paint: {
      'model-scale': MODEL.scale,
      // Follow terrain until usable DEM samples are available, then use
      // the smoothed route profile instead of terrain-derived model tilt.
      'model-elevation-reference': 'ground',
    },
  });

  // Frame the train at Accra before the initial playback frame.
  const staticTrainPt = [STATIONS[0].lng, STATIONS[0].lat];
  const staticCamPt = chaseCameraPoint(staticTrainPt, initialHeading);
  positionChaseCamera(staticCamPt, staticTrainPt);

  // HUD static fields
  document.getElementById('routeOrigin').textContent = STATIONS[0].name;
  document.getElementById('routeDestination').textContent = STATIONS[STATIONS.length - 1].name;
  document.getElementById('routeDistance').textContent = Math.round(totalDistanceKm) + ' km';
  document.getElementById('labelStart').textContent = STATIONS[0].name;
  document.getElementById('labelEnd').textContent = STATIONS[STATIONS.length - 1].name;
  document.getElementById('timeTotal').textContent = formatTime(JOURNEY.totalDurationSeconds);

  hideSplashScreen();
  // Intentionally NOT auto-starting: the page should load paused, with
  // the train stationary at Accra, until the user presses Play.
  } catch (error) {
    mapInitialized = false;
    console.error('Map initialization failed:', error);
    window.showSplashError(`Map initialization failed: ${error.message || error}`);
  }
}

map.once('style.load', initializeMap);
if (map.isStyleLoaded()) {
  setTimeout(initializeMap, 0);
}

// ---------------------------------------------------------------
// Playback / animation
// ---------------------------------------------------------------
function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const Playback = (() => {
  let playing = false;
  let elapsed = 0; // seconds
  let lastFrameTime = null;
  let rafId = null;
  let arrived = false;

  function currentStationIndex(distanceKm) {
    for (let i = STATIONS.length - 1; i >= 0; i--) {
      if (distanceKm >= STATIONS[i].distanceKm) return i;
    }
    return 0;
  }

  function updateHUD(distanceKm, fraction) {
    const idx = currentStationIndex(distanceKm);
    const current = STATIONS[idx];
    const next = STATIONS[idx + 1] || STATIONS[idx];
    const toNextKm = Math.max(0, next.distanceKm - distanceKm);

    document.getElementById('journeyCurrent').textContent = current.name;
    document.getElementById('journeyNext').textContent = idx < STATIONS.length - 1 ? next.name : '—';
    const journeyToNext = document.getElementById('journeyToNext');
    if (journeyToNext) {
      journeyToNext.textContent = idx < STATIONS.length - 1 ? Math.round(toNextKm) + ' km' : 'Arrived';
    }
    document.getElementById('journeyPercent').textContent = Math.round(fraction * 100) + '%';
    document.getElementById('timeElapsed').textContent = formatTime(elapsed);
    document.getElementById('progressFill').style.width = (fraction * 100) + '%';
  }

  // Renders the model/camera/HUD for a given elapsed time. Shared by the
  // normal playback loop and seek() (scrubbing), so dragging the progress
  // bar updates the exact same things, whether playing or paused.
  function renderAt(elapsedSeconds) {
    const fraction = Math.min(elapsedSeconds / JOURNEY.totalDurationSeconds, 1);
    const distanceKm = fraction * totalDistanceKm;

    const trainLngLat = turf.along(fullRoute, distanceKm, { units: 'kilometers' }).geometry.coordinates;
    const headingDeg = headingAt(distanceKm);

    // Update the model position and heading for this route frame.
    const modelSource = map.getSource('train-model-source');
    if (modelSource) {
      modelSource.setModels({
        'ghana-freight-train': {
          uri: MODEL.uri,
          position: centeredModelPosition(trainLngLat, headingDeg),
          orientation: [0, 0, headingDeg + MODEL.bearingOffsetDeg],
        },
      });
    }
    const trainGroundElevation = getTrainGroundElevation(distanceKm);
    if (Number.isFinite(trainGroundElevation)) {
      if (!trainTerrainProfileActive) {
        map.setPaintProperty('train-model-layer', 'model-elevation-reference', 'sea');
        trainTerrainProfileActive = true;
      }
      map.setPaintProperty('train-model-layer', 'model-translation', [0, 0, trainGroundElevation]);
    }

    // Chase camera — offset behind AND to the side of the train, so the
    // shot shows its length/profile plus terrain, not just its back end.
    const camLngLat = chaseCameraPoint(trainLngLat, headingDeg);
    positionChaseCamera(camLngLat, trainLngLat);

    updateHUD(distanceKm, fraction);
    return fraction;
  }

  function frame(now) {
    if (!playing) return;
    if (lastFrameTime === null) lastFrameTime = now;
    const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;
    elapsed = Math.min(elapsed + dt, JOURNEY.totalDurationSeconds);

    const fraction = renderAt(elapsed);

    if (fraction >= 1 && !arrived) {
      arrived = true;
      onArrival();
    }

    if (elapsed < JOURNEY.totalDurationSeconds) {
      rafId = requestAnimationFrame(frame);
    } else {
      playing = false;
      setPlayIcon(false);
    }
  }

  function start() {
    playing = true;
    lastFrameTime = null;
    setPlayIcon(true);
    rafId = requestAnimationFrame(frame);
  }
  function pause() {
    playing = false;
    setPlayIcon(false);
    if (rafId) cancelAnimationFrame(rafId);
  }
  function toggle() {
    if (arrived) restart();
    else if (playing) pause();
    else start();
  }
  function restart() {
    pause();
    elapsed = 0;
    arrived = false;
    document.getElementById('arrivalPanel').classList.remove('show');
    document.getElementById('routeStatus').textContent = 'En Route';
    start();
  }

  // Scrub to an arbitrary point in the journey (0 to 1). Works whether
  // paused or playing — renders immediately so dragging feels live.
  function seek(fraction) {
    const clamped = Math.max(0, Math.min(1, fraction));
    elapsed = clamped * JOURNEY.totalDurationSeconds;
    lastFrameTime = null; // avoid a big dt jump on the next playing frame

    if (clamped < 1 && arrived) {
      arrived = false;
      document.getElementById('arrivalPanel').classList.remove('show');
      document.getElementById('routeStatus').textContent = 'En Route';
    }

    const renderedFraction = renderAt(elapsed);
    if (renderedFraction >= 1 && !arrived) {
      arrived = true;
      onArrival();
    }
  }

  return { start, pause, toggle, restart, seek, get playing() { return playing; } };
})();

function setPlayIcon(isPlaying) {
  document.getElementById('iconPlay').style.display = isPlaying ? 'none' : 'block';
  document.getElementById('iconPause').style.display = isPlaying ? 'block' : 'none';
}

function onArrival() {
  document.getElementById('routeStatus').textContent = 'Arrived';
  document.getElementById('arrivalStation').textContent = STATIONS[STATIONS.length - 1].name;
  document.getElementById('arrivalPanel').classList.add('show');
}

// ---------------------------------------------------------------
// Controls
// ---------------------------------------------------------------
document.getElementById('btnPlayPause').addEventListener('click', () => Playback.toggle());
document.getElementById('btnRestart').addEventListener('click', () => Playback.restart());
document.getElementById('btnArrivalRestart').addEventListener('click', () => Playback.restart());

// Progress bar — click or drag anywhere on it to jump to that point in
// the journey. Pauses while actively dragging, resumes afterward only
// if it was already playing.
(function setupSeekBar() {
  const track = document.getElementById('progressTrack');
  if (!track) return; // index.html needs id="progressTrack" on .progress-track
  track.style.cursor = 'pointer';
  track.style.touchAction = 'none';

  function fractionFromEvent(evt) {
    const rect = track.getBoundingClientRect();
    const point = evt.touches ? evt.touches[0] : evt;
    const x = Math.max(rect.left, Math.min(point.clientX, rect.right));
    return (x - rect.left) / rect.width;
  }

  let dragging = false;
  let wasPlaying = false;

  function startDrag(evt) {
    dragging = true;
    wasPlaying = Playback.playing;
    Playback.pause();
    Playback.seek(fractionFromEvent(evt));
    evt.preventDefault();
  }
  function moveDrag(evt) {
    if (!dragging) return;
    Playback.seek(fractionFromEvent(evt));
    evt.preventDefault();
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    if (wasPlaying) Playback.start();
  }

  track.addEventListener('mousedown', startDrag);
  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('mouseup', endDrag);

  track.addEventListener('touchstart', startDrag, { passive: false });
  window.addEventListener('touchmove', moveDrag, { passive: false });
  window.addEventListener('touchend', endDrag);
})();
