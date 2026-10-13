/* ============================================================
   CENTRAL CORRIDOR — APP
   Ghana Railway Development Authority
   ============================================================ */

mapboxgl.accessToken = MAPBOX_TOKEN;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function tileCacheLimit(container) {
  const columns = Math.ceil(container.clientWidth / PRELOAD.tileSizePx) + 2;
  const rows = Math.ceil(container.clientHeight / PRELOAD.tileSizePx) + 2;
  const viewportTiles = columns * rows * PRELOAD.cacheViewportMultiplier;
  return Math.min(PRELOAD.maxCachedTilesPerSource, Math.max(16, viewportTiles));
}

const map = new mapboxgl.Map({
  container: 'map',
  style: MAP_STYLE,
  center: [STATIONS[0].lng, STATIONS[0].lat],
  zoom: 14,
  pitch: CAMERA.pitch,
  bearing: 0,
  antialias: true,
  maxTileCacheSize: tileCacheLimit(document.getElementById('map')),
});

const mainMapErrors = [];
const mainCoverageSources = new Set();
let mapInitialized = false;
function captureMainMapError(event) {
  if (mainMapErrors.length < 100) mainMapErrors.push(event);
  if (!mapInitialized && event.error) {
    window.showSplashError(`Map initialization failed: ${event.error.message || 'Map style request failed.'} Check connectivity and retry.`);
  }
}
map.on('error', captureMainMapError);
const initialStyleTimeout = setTimeout(() => {
  if (!mapInitialized) {
    window.showSplashError('Map style did not load. Check connectivity and Mapbox access, then retry.');
  }
}, PRELOAD.viewportTimeoutMs);

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

function routeCoordinateAt(distanceKm) {
  const distance = Math.max(0, Math.min(distanceKm, totalDistanceKm));
  return turf.along(fullRoute, distance, { units: 'kilometers' }).geometry.coordinates;
}

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
function terrainElevationAt(targetMap, lngLat, fallbackElevation = 0) {
  const elevation = targetMap.queryTerrainElevation(lngLat, { exaggerated: false });
  return Number.isFinite(elevation) ? elevation : fallbackElevation;
}

// ---------------------------------------------------------------
// Chase camera — positions the free camera behind and above a target,
// shared by the initial framing shot and the per-frame playback chase.
// ---------------------------------------------------------------
function positionChaseCamera(targetMap, camLngLat, trainLngLat, headingDeg, fallbackElevation = 0) {
  const camAltitude = terrainElevationAt(targetMap, camLngLat, fallbackElevation) + CAMERA.heightAboveGroundM;
  const lookAheadPoint = turf.destination(
    trainLngLat,
    CAMERA.lookAheadKm,
    headingDeg,
    { units: 'kilometers' },
  ).geometry.coordinates;
  const lookAheadAltitude = terrainElevationAt(targetMap, lookAheadPoint, fallbackElevation) + 2;

  const camMerc = mapboxgl.MercatorCoordinate.fromLngLat(camLngLat, camAltitude);

  const freeCam = targetMap.getFreeCameraOptions();
  freeCam.position = camMerc;
  // lookAtPoint's real signature is (lngLat, upVector?, altitude?) — it
  // does NOT take a MercatorCoordinate. Aim beyond the train to reveal more
  // of the route ahead instead of centering the train in the view.
  freeCam.lookAtPoint(lookAheadPoint, [0, 0, 1], lookAheadAltitude);
  targetMap.setFreeCameraOptions(freeCam);
}

// Heading (compass degrees, 0 = north) of travel at a given distance
// along the route, from a short lookahead sample.
function headingAt(distanceKm) {
  const aheadKm = Math.min(distanceKm + 0.05, totalDistanceKm);
  const behindKm = Math.max(distanceKm - 0.05, 0);
  const a = routeCoordinateAt(behindKm);
  const b = routeCoordinateAt(aheadKm);
  return turf.bearing(a, b);
}

// Chase camera point: directly behind the train along the route.
function chaseCameraPoint(trainLngLat, headingDeg) {
  return turf.destination(
    trainLngLat,
    CAMERA.chaseBehindKm,
    headingDeg + 180,
    { units: 'kilometers' }
  ).geometry.coordinates;
}

let modelTerrainPose = {
  pitchDegrees: 0,
  verticalOffsetMeters: MODEL.groundClearanceMeters,
};
let lastModelGroundSampleTime = -Infinity;

function modelTerrainPoseAt(trainLngLat, headingDeg, forceRefresh = false) {
  const now = performance.now();
  if (!forceRefresh && now - lastModelGroundSampleTime < 100) return modelTerrainPose;
  lastModelGroundSampleTime = now;

  const routeElevation = map.queryTerrainElevation(trainLngLat, { exaggerated: false });
  if (!Number.isFinite(routeElevation)) return modelTerrainPose;

  const footprintLength = MODEL.terrainFootprintAheadMeters + MODEL.terrainFootprintBehindMeters;
  const sampleCount = Math.ceil(footprintLength / MODEL.terrainSampleSpacingMeters);
  const terrainProfile = [];

  for (let index = 0; index <= sampleCount; index++) {
    const offsetMeters = -MODEL.terrainFootprintAheadMeters +
      footprintLength * index / sampleCount;
    const probePoint = turf.destination(
      trainLngLat,
      Math.abs(offsetMeters) / 1000,
      headingDeg + (offsetMeters >= 0 ? 180 : 0),
      { units: 'kilometers' },
    ).geometry.coordinates;
    const elevation = map.queryTerrainElevation(probePoint, { exaggerated: false });
    if (!Number.isFinite(elevation)) return modelTerrainPose;
    terrainProfile.push({ offsetMeters, elevation });
  }

  const slopeNumerator = terrainProfile.reduce((sum, sample) => {
    return sum + sample.offsetMeters * (sample.elevation - routeElevation);
  }, 0);
  const slopeDenominator = terrainProfile.reduce((sum, sample) => {
    return sum + sample.offsetMeters * sample.offsetMeters;
  }, 0);
  const maxPitchRadians = MODEL.maxTerrainPitchDegrees * Math.PI / 180;
  const slope = Math.max(
    -Math.tan(maxPitchRadians),
    Math.min(Math.tan(maxPitchRadians), slopeNumerator / slopeDenominator),
  );
  const pitchDegrees = Math.atan(slope) * 180 / Math.PI;
  const highestResidual = terrainProfile.reduce((highest, sample) => {
    const residual = sample.elevation - (routeElevation + slope * sample.offsetMeters);
    return Math.max(highest, residual);
  }, 0);

  modelTerrainPose = {
    pitchDegrees,
    verticalOffsetMeters: MODEL.groundClearanceMeters + highestResidual,
  };
  return modelTerrainPose;
}

function trainFeatureAt(distanceKm, forceTerrainRefresh = false) {
  const coordinates = routeCoordinateAt(distanceKm);
  const headingDeg = headingAt(distanceKm);
  const terrainPose = modelTerrainPoseAt(coordinates, headingDeg, forceTerrainRefresh);
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: {
      modelRotation: [
        terrainPose.pitchDegrees,
        0,
        headingDeg + MODEL.bearingOffsetDeg,
      ],
      modelTranslation: [0, 0, terrainPose.verticalOffsetMeters],
    },
  };
}

function requiredRasterSourceIds(targetMap) {
  const sources = targetMap.getStyle().sources || {};
  return new Set(Object.keys(sources).filter((id) => {
    return sources[id].type === 'raster' || sources[id].type === 'raster-dem';
  }));
}

function throwOnCoverageErrors(errors, sourceIds) {
  const failure = errors.find((event) => sourceIds.has(event.sourceId));
  if (failure) {
    const status = failure.error && (failure.error.status || failure.error.statusCode);
    const detail = status
      ? `HTTP ${status}`
      : failure.error && failure.error.message ? failure.error.message : 'tile request failed';
    throw new Error(`Required terrain or satellite imagery failed to load (${failure.sourceId}): ${detail}`);
  }
}

function waitForMapStyle(targetMap, timeoutMs) {
  if (targetMap.isStyleLoaded()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      targetMap.off('style.load', onStyleLoad);
      reject(new Error('Map style did not finish loading before the preload timeout.'));
    }, timeoutMs);
    function onStyleLoad() {
      clearTimeout(timeout);
      resolve();
    }
    targetMap.once('style.load', onStyleLoad);
  });
}

function waitForMapSettled(targetMap, timeoutMs) {
  return new Promise((resolve, reject) => {
    let rendered = false;
    let checking = false;
    let finished = false;
    const timeout = setTimeout(() => finish(new Error('Map tiles did not settle before the viewport timeout.')), timeoutMs);

    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      targetMap.off('render', onRender);
      targetMap.off('idle', check);
      if (error) reject(error);
      else resolve();
    }

    function verifyAfterRender() {
      checking = false;
      if (targetMap.isStyleLoaded() && targetMap.areTilesLoaded()) finish();
      else check();
    }

    function check() {
      if (finished || checking || !rendered) return;
      if (!targetMap.isStyleLoaded() || !targetMap.areTilesLoaded()) return;
      checking = true;
      requestAnimationFrame(() => requestAnimationFrame(verifyAfterRender));
    }

    function onRender() {
      rendered = true;
      check();
    }

    targetMap.on('render', onRender);
    targetMap.on('idle', check);
    targetMap.triggerRepaint();
  });
}

function remainingPreloadTime(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('The route terrain and imagery preload exceeded its time budget.');
  return Math.min(remaining, PRELOAD.viewportTimeoutMs);
}

async function preloadRouteCoverage() {
  const deadline = Date.now() + PRELOAD.totalTimeoutMs;
  const currentStyle = map.getStyle();
  const imagerySources = Object.entries(currentStyle.sources || {}).filter(([, source]) => {
    return source.type === 'raster';
  });
  if (!imagerySources.length) {
    throw new Error('The current map style has no raster imagery source to preload.');
  }
  const preloadStyle = {
    version: 8,
    sources: Object.fromEntries(imagerySources),
    layers: imagerySources.map(([sourceId]) => ({
      id: `preload-${sourceId}`,
      type: 'raster',
      source: sourceId,
    })),
  };
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(fullRoute);
  const width = Math.max(320, map.getCanvas().clientWidth);
  const height = Math.max(240, map.getCanvas().clientHeight);
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  Object.assign(container.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  document.body.appendChild(container);

  let preloadMap;
  const errors = [];
  const requiredSources = new Set();
  const observedTiles = new Set();
  const onPreloadError = (event) => {
    if (errors.length < PRELOAD.maxUniqueTiles) errors.push(event);
  };

  try {
    preloadMap = new mapboxgl.Map({
      container,
      style: preloadStyle,
      center: routeCoordinateAt(totalDistanceKm / 2),
      zoom: 3,
      pitch: 0,
      bearing: 0,
      interactive: false,
      attributionControl: false,
      antialias: true,
      maxTileCacheSize: tileCacheLimit(container),
    });
    preloadMap.on('error', onPreloadError);
    window.updateSplashProgress(2, 'Preparing route-wide base terrain and imagery…');
    await waitForMapStyle(preloadMap, remainingPreloadTime(deadline));

    for (const sourceId of requiredRasterSourceIds(preloadMap)) requiredSources.add(sourceId);
    preloadMap.addSource('preload-terrain', {
      type: 'raster-dem',
      url: TERRAIN_SOURCE_URL,
      tileSize: 512,
      maxzoom: 14,
    });
    requiredSources.add('preload-terrain');
    preloadMap.setTerrain({ source: 'preload-terrain', exaggeration: 1 });

    preloadMap.on('sourcedata', (event) => {
      if (!requiredSources.has(event.sourceId) || !event.coord) return;
      const coord = event.coord;
      const canonical = coord.canonical || coord;
      observedTiles.add(`${event.sourceId}:${canonical.z}/${canonical.x}/${canonical.y}`);
    });

    const paddingPx = Math.ceil(Math.min(width, height) * PRELOAD.routePaddingRatio);
    preloadMap.fitBounds(
      [[minLng, minLat], [maxLng, maxLat]],
      {
        padding: {
          top: paddingPx,
          right: paddingPx,
          bottom: paddingPx,
          left: paddingPx,
        },
        duration: 0,
      },
    );
    await waitForMapSettled(preloadMap, remainingPreloadTime(deadline));
    throwOnCoverageErrors(errors, requiredSources);

    const sampleDistances = new Set(
      Array.from({ length: PRELOAD.routeElevationSampleCount }, (_, index) => {
        return totalDistanceKm * index / (PRELOAD.routeElevationSampleCount - 1);
      }),
    );
    STATIONS.forEach((station) => sampleDistances.add(station.distanceKm));
    const sortedSamples = [...sampleDistances].sort((a, b) => a - b);
    for (let index = 0; index < sortedSamples.length; index++) {
      const distanceKm = sortedSamples[index];
      const point = routeCoordinateAt(distanceKm);
      const elevation = preloadMap.queryTerrainElevation(point, { exaggerated: false });
      if (!Number.isFinite(elevation)) {
        throw new Error(`Base terrain elevation is unavailable near route distance ${distanceKm.toFixed(1)} km.`);
      }
      window.updateSplashProgress(
        5 + 75 * (index + 1) / sortedSamples.length,
        `Checking route-wide base terrain: ${index + 1} of ${sortedSamples.length} route samples.`,
      );
      if (observedTiles.size > PRELOAD.maxUniqueTiles) {
        throw new Error(
          `Route-wide base coverage exceeded the ${PRELOAD.maxUniqueTiles.toLocaleString()}-tile limit. ` +
          'Playback remains paused; reduce the viewport size or adjust PRELOAD.maxUniqueTiles.'
        );
      }
    }

    throwOnCoverageErrors(errors, requiredSources);
    window.updateSplashProgress(
      88,
      'Route-wide base coverage verified. Close-up terrain and imagery will stream during travel.',
    );
  } finally {
    if (preloadMap) {
      preloadMap.off('error', onPreloadError);
      preloadMap.remove();
    } else {
      container.remove();
    }
  }
}

// ---------------------------------------------------------------
// The native 3D model is the only train visual; the old canvas
// billboard and custom WebGL layer have been removed.
// ---------------------------------------------------------------


// ---------------------------------------------------------------
// Map initialization
// ---------------------------------------------------------------
function initializeMap() {
  if (mapInitialized) return;
  mapInitialized = true;
  clearTimeout(initialStyleTimeout);

  try {
  // Terrain
  map.addSource('mapbox-dem', {
    type: 'raster-dem',
    url: TERRAIN_SOURCE_URL,
    tileSize: 512,
    maxzoom: 14,
  });
  map.setTerrain({ source: 'mapbox-dem', exaggeration: 1 });
  // Bright, clear-morning sky — not nulled, not heavy haze. Fully
  // disabling fog (an earlier attempt, map.setFog(null)) removed the
  // only thing giving the space beyond the terrain a sky color at all,
  // which is why it rendered as a flat dark "night" void instead of a
  // bright one. horizon-blend kept low so it still reads as clear, not
  // foggy/hazy.
  map.setFog({
    'color': '#eaf4ff',
    'high-color': '#bcdcff',
    'horizon-blend': 0.02,
    'space-color': '#bcdcff',
    'star-intensity': 0,
  });
  map.addLayer({
    id: 'sky-layer',
    type: 'sky',
    paint: {
      'sky-type': 'atmosphere',
      'sky-atmosphere-sun-intensity': 10,
    },
  });
  for (const sourceId of requiredRasterSourceIds(map)) mainCoverageSources.add(sourceId);

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
  // Train — model rotation follows route bearing; the GeoJSON point stays
  // at the exact distance-along-route coordinate used by the yellow line.
  // ---------------------------------------------------------------
  const initialHeading = headingAt(0);
  map.addModel('ghana-freight-train', MODEL.uri);
  map.addSource('train-position-source', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [trainFeatureAt(0)] },
  });
  map.addLayer({
    id: 'train-model-layer',
    type: 'model',
    source: 'train-position-source',
    layout: { 'model-id': 'ghana-freight-train' },
    paint: {
      'model-scale': MODEL.scale,
      'model-translation': ['get', 'modelTranslation'],
      'model-elevation-reference': 'ground',
      'model-rotation': ['get', 'modelRotation'],
    },
  });

  const initialPoint = routeCoordinateAt(0);
  positionChaseCamera(map, chaseCameraPoint(initialPoint, initialHeading), initialPoint, initialHeading);

  // HUD static fields
  document.getElementById('routeOrigin').textContent = STATIONS[0].name;
  document.getElementById('routeDestination').textContent = STATIONS[STATIONS.length - 1].name;
  document.getElementById('routeDistance').textContent = Math.round(totalDistanceKm) + ' km';
  document.getElementById('labelStart').textContent = STATIONS[0].name;
  document.getElementById('labelEnd').textContent = STATIONS[STATIONS.length - 1].name;
  document.getElementById('timeTotal').textContent = formatTime(JOURNEY.totalDurationSeconds);

  window.updateSplashProgress(1, 'Map ready. Measuring and preloading route coverage…');
  completeStartup().catch((error) => {
    console.error('Route terrain and imagery preload failed:', error);
    window.showSplashError(
      `Route preload failed: ${error.message || error} Check connectivity and Mapbox access, then retry.`,
    );
  });
  } catch (error) {
    mapInitialized = false;
    console.error('Map initialization failed:', error);
    window.showSplashError(`Map initialization failed: ${error.message || error}`);
  }
}

async function completeStartup() {
  await preloadRouteCoverage();

  map.resize();
  Playback.renderInitial();
  await waitForMapSettled(map, PRELOAD.viewportTimeoutMs);
  throwOnCoverageErrors(mainMapErrors, mainCoverageSources);
  if (!Number.isFinite(map.queryTerrainElevation(routeCoordinateAt(0), { exaggerated: false }))) {
    throw new Error('The initial terrain elevation is unavailable after the map settled.');
  }

  Playback.renderInitial();
  await waitForMapSettled(map, PRELOAD.viewportTimeoutMs);
  throwOnCoverageErrors(mainMapErrors, mainCoverageSources);
  Playback.enable();
  map.off('error', captureMainMapError);
  window.hideSplashScreen();
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
  let playbackReady = false;
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
  function renderAt(elapsedSeconds, forceTerrainRefresh = false) {
    const fraction = Math.min(elapsedSeconds / JOURNEY.totalDurationSeconds, 1);
    const distanceKm = fraction * totalDistanceKm;

    const trainLngLat = routeCoordinateAt(distanceKm);
    const headingDeg = headingAt(distanceKm);

    map.getSource('train-position-source').setData({
      type: 'FeatureCollection',
      features: [trainFeatureAt(distanceKm, forceTerrainRefresh)],
    });

    // Keep the camera centered behind the train and above the terrain.
    const camLngLat = chaseCameraPoint(trainLngLat, headingDeg);
    positionChaseCamera(map, camLngLat, trainLngLat, headingDeg);

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
    if (!playbackReady) return;
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
    if (!playbackReady) return;
    if (arrived) restart();
    else if (playing) pause();
    else start();
  }
  function restart() {
    if (!playbackReady) return;
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
    if (!playbackReady) return;
    const clamped = Math.max(0, Math.min(1, fraction));
    elapsed = clamped * JOURNEY.totalDurationSeconds;
    lastFrameTime = null; // avoid a big dt jump on the next playing frame

    if (clamped < 1 && arrived) {
      arrived = false;
      document.getElementById('arrivalPanel').classList.remove('show');
      document.getElementById('routeStatus').textContent = 'En Route';
    }

    const renderedFraction = renderAt(elapsed, true);
    if (renderedFraction >= 1 && !arrived) {
      arrived = true;
      onArrival();
    }
  }

  function renderInitial() {
    elapsed = 0;
    arrived = false;
    renderAt(0, true);
  }

  function enable() {
    playbackReady = true;
    document.getElementById('btnPlayPause').disabled = false;
    document.getElementById('btnRestart').disabled = false;
    const track = document.getElementById('progressTrack');
    track.setAttribute('aria-disabled', 'false');
    track.style.pointerEvents = 'auto';
  }

  return {
    start,
    pause,
    toggle,
    restart,
    seek,
    renderInitial,
    enable,
    get playing() { return playing; },
  };
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