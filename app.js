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

map.on('error', (event) => {
  const status = event.error && event.error.status;
  if (status === 401 || status === 403) {
    window.showSplashError('Mapbox rejected the token. Check its status and allowed domains.');
  }
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
function getElevation(lngLat) {
  const el = map.queryTerrainElevation(lngLat, { exaggerated: false });
  return el || 0;
}

// ---------------------------------------------------------------
// Train visual — same approach as the Western Corridor build:
// a canvas-drawn pictogram (badge + cab + windows + wheels + soft
// halo) rendered through a native custom WebGL layer, so its
// position is read straight from a JS variable at draw time with
// zero worker/GeoJSON latency. Falls back to a GeoJSON point +
// circle glow + icon symbol layer if the custom layer fails.
// ---------------------------------------------------------------
function trainCanvas() {
  const c = document.createElement('canvas');
  c.width = c.height = 192;
  const x = c.getContext('2d');
  const h = x.createRadialGradient(96, 96, 20, 96, 96, 96);
  h.addColorStop(0, 'rgba(252,209,22,.45)');
  h.addColorStop(1, 'rgba(252,209,22,0)');
  x.fillStyle = h;
  x.fillRect(0, 0, 192, 192);
  x.translate(32, 32);
  x.scale(2, 2);
  const rr = (a, b, w, h2, r) => {
    x.beginPath();
    x.moveTo(a + r, b);
    x.arcTo(a + w, b, a + w, b + h2, r);
    x.arcTo(a + w, b + h2, a, b + h2, r);
    x.arcTo(a, b + h2, a, b, r);
    x.arcTo(a, b, a + w, b, r);
    x.closePath();
  };
  x.beginPath();
  x.arc(32, 32, 29.5, 0, 7);
  x.fillStyle = '#fcd116';
  x.fill();
  x.lineWidth = 3;
  x.strokeStyle = '#071018';
  x.stroke();
  x.fillStyle = '#071018';
  rr(19, 13, 26, 31, 7);
  x.fill();
  x.fillStyle = '#fcd116';
  rr(23, 18, 18, 11, 3);
  x.fill();
  x.beginPath();
  x.arc(26, 37, 2.4, 0, 7);
  x.arc(38, 37, 2.4, 0, 7);
  x.fill();
  x.strokeStyle = '#071018';
  x.lineWidth = 3;
  x.lineCap = 'round';
  x.beginPath();
  x.moveTo(25, 46);
  x.lineTo(19, 54);
  x.moveTo(39, 46);
  x.lineTo(45, 54);
  x.stroke();
  return c;
}

const trainLayer = {
  id: 'train-gl',
  type: 'custom',
  renderingMode: '3d',
  ok: false,
  pos: null,
  onAdd(m, gl) {
    this.map = m;
    const sh = (t, src) => {
      const o = gl.createShader(t);
      gl.shaderSource(o, src);
      gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
      return o;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'uniform mat4 u_m;uniform vec3 u_p;uniform vec2 u_s;attribute vec2 a_c;varying vec2 v;void main(){vec4 c=u_m*vec4(u_p,1.0);c.xy+=a_c*u_s*c.w;v=vec2(a_c.x*.5+.5,.5-a_c.y*.5);gl_Position=c;}'));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, 'precision mediump float;uniform sampler2D u_t;varying vec2 v;void main(){gl_FragColor=texture2D(u_t,v);}'));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('train shader link failed');
    this.pr = pr;
    this.u = { m: gl.getUniformLocation(pr, 'u_m'), p: gl.getUniformLocation(pr, 'u_p'), s: gl.getUniformLocation(pr, 'u_s'), t: gl.getUniformLocation(pr, 'u_t') };
    this.a = gl.getAttribLocation(pr, 'a_c');
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, trainCanvas());
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]].forEach((q) => gl.texParameteri(gl.TEXTURE_2D, q[0], q[1]));
    this.ok = true;
  },
  render(gl, matrix) {
    if (!this.ok || !this.pos) return;
    const cv = this.map.getCanvas();
    const sz = cv.clientWidth < 600 ? 84 : 104;
    gl.useProgram(this.pr);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniformMatrix4fv(this.u.m, false, matrix);
    gl.uniform3f(this.u.p, this.pos[0], this.pos[1], this.pos[2]);
    gl.uniform2f(this.u.s, sz / cv.clientWidth, sz / cv.clientHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.t, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.a);
    gl.vertexAttribPointer(this.a, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(this.a);
    // Restore WebGL state. Mapbox GL JS does not reset context state
    // between layers/frames — a custom layer is responsible for putting
    // it back. Leaving DEPTH_TEST disabled here was the actual bug:
    // it broke Mapbox's own terrain-draped satellite rendering on
    // later frames (route lines and this custom layer kept drawing
    // fine since they don't rely on depth testing against terrain,
    // which is exactly why only the imagery disappeared).
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  },
};

let useGL = false;

// ---------------------------------------------------------------
// Map load
// ---------------------------------------------------------------
map.on('load', () => {
  // Terrain
  map.addSource('mapbox-dem', {
    type: 'raster-dem',
    url: TERRAIN_SOURCE_URL,
    tileSize: 512,
    maxzoom: 14,
  });
  map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.25 });

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

  // Train — custom GL layer primary path, GeoJSON+icon fallback
  try {
    map.addLayer(trainLayer);
    useGL = trainLayer.ok;
  } catch (e) {
    console.error('train GL layer failed, using fallback:', e.message);
  }
  if (!useGL) {
    if (map.getLayer('train-gl')) map.removeLayer('train-gl');
    map.addSource('train', { type: 'geojson', data: turf.point(fullRoute.geometry.coordinates[0]) });
    map.addLayer({
      id: 'train-glow',
      type: 'circle',
      source: 'train',
      paint: { 'circle-radius': 28, 'circle-color': '#fcd116', 'circle-opacity': 0.3, 'circle-blur': 0.8 },
    });
    try {
      map.addImage('train-icon', trainCanvas().getContext('2d').getImageData(0, 0, 192, 192), { pixelRatio: 2 });
      map.addLayer({
        id: 'train-core',
        type: 'symbol',
        source: 'train',
        layout: { 'icon-image': 'train-icon', 'icon-allow-overlap': true, 'icon-ignore-placement': true },
      });
    } catch (e) {
      map.addLayer({
        id: 'train-core',
        type: 'circle',
        source: 'train',
        paint: { 'circle-radius': 6, 'circle-color': '#fcd116', 'circle-stroke-color': '#071018', 'circle-stroke-width': 1.5 },
      });
    }
  }

  // HUD static fields
  document.getElementById('routeOrigin').textContent = STATIONS[0].name;
  document.getElementById('routeDestination').textContent = STATIONS[STATIONS.length - 1].name;
  document.getElementById('routeDistance').textContent = Math.round(totalDistanceKm) + ' km';
  document.getElementById('labelStart').textContent = STATIONS[0].name;
  document.getElementById('labelEnd').textContent = STATIONS[STATIONS.length - 1].name;
  document.getElementById('timeTotal').textContent = formatTime(JOURNEY.totalDurationSeconds);

  hideSplashScreen();
  Playback.start();
});

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
    document.getElementById('journeyToNext').textContent = idx < STATIONS.length - 1 ? Math.round(toNextKm) + ' km' : 'Arrived';
    document.getElementById('journeyPercent').textContent = Math.round(fraction * 100) + '%';
    document.getElementById('timeElapsed').textContent = formatTime(elapsed);
    document.getElementById('progressFill').style.width = (fraction * 100) + '%';
  }

  function frame(now) {
    if (!playing) return;
    if (lastFrameTime === null) lastFrameTime = now;
    const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;
    elapsed = Math.min(elapsed + dt, JOURNEY.totalDurationSeconds);

    const fraction = elapsed / JOURNEY.totalDurationSeconds;
    const distanceKm = fraction * totalDistanceKm;

    const trainLngLat = turf.along(fullRoute, distanceKm, { units: 'kilometers' }).geometry.coordinates;

    // Update train visual — GL layer position, or GeoJSON fallback
    if (useGL) {
      const gt = map.queryTerrainElevation(trainLngLat);
      const tz = gt != null ? gt : getElevation(trainLngLat);
      const mc = mapboxgl.MercatorCoordinate.fromLngLat(trainLngLat, tz + 2);
      trainLayer.pos = [mc.x, mc.y, mc.z];
      map.triggerRepaint();
    } else {
      map.getSource('train').setData(turf.point(trainLngLat));
    }

    // Chase camera — real km offset behind the train, terrain-relative height
    const camDistanceKm = Math.max(0, distanceKm - CAMERA.chaseBehindKm);
    const camPt = turf.along(fullRoute, camDistanceKm, { units: 'kilometers' });
    const camLngLat = camPt.geometry.coordinates;

    const camAltitude = getElevation(camLngLat) + CAMERA.heightAboveTerrainM;
    const trainAltitude = getElevation(trainLngLat) + 8;

    const camMerc = mapboxgl.MercatorCoordinate.fromLngLat(camLngLat, camAltitude);
    const trainMerc = mapboxgl.MercatorCoordinate.fromLngLat(trainLngLat, trainAltitude);

    const freeCam = map.getFreeCameraOptions();
    freeCam.position = camMerc;
    freeCam.lookAtPoint(trainLngLat);
    map.setFreeCameraOptions(freeCam);

    updateHUD(distanceKm, fraction);

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

  return { start, pause, toggle, restart, get playing() { return playing; } };
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

// ---------------------------------------------------------------
// PWA service worker
// ---------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}