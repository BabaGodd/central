/* ============================================================
   SPLASH SCREEN CONTROLLER
   Rotates status messages tied to real load progress and exposes
   a global hideSplashScreen() called once the map style is initialized
   fires (after terrain/route/train are all initialized).
   ============================================================ */

(function () {
  const statusEl = document.getElementById('splashStatus');
  const progressBar = document.getElementById('splashProgressBar');
  const splashEl = document.getElementById('splash');
  let hasError = false;
  let stageIndex = 0;

  const loadTimeout = setTimeout(() => {
    window.showSplashError('Map loading timed out. Check the connection and Mapbox token.');
  }, 20000);

  const STAGES = [
    { pct: 15, text: 'Initializing terrain engine…' },
    { pct: 40, text: 'Loading satellite imagery…' },
    { pct: 65, text: 'Tracing Central Corridor route…' },
    { pct: 85, text: 'Positioning chase camera…' },
    { pct: 97, text: 'Finalizing route simulation…' },
  ];

  function setProgress(pct) {
    progressBar.style.width = Math.min(pct, 100) + '%';
  }

  // Advance through stages on a timer, but never claim 100% until
  // hideSplashScreen() is actually called by app.js on map 'load'.
  function tick() {
    if (hasError || stageIndex >= STAGES.length) return;
    const stage = STAGES[stageIndex];
    statusEl.style.opacity = 0;
    setTimeout(() => {
      if (hasError) return;
      statusEl.textContent = stage.text;
      statusEl.style.opacity = 1;
      setProgress(stage.pct);
    }, 180);
    stageIndex++;
    if (stageIndex < STAGES.length) {
      setTimeout(tick, 900);
    }
  }
  tick();

  window.showSplashError = function (message) {
    if (hasError) return;
    hasError = true;
    clearTimeout(loadTimeout);
    statusEl.textContent = message;
    statusEl.style.opacity = 1;
    splashEl.classList.remove('hidden');
    splashEl.classList.add('has-error');
    document.getElementById('app').classList.remove('ready');
  };

  window.hideSplashScreen = function () {
    if (hasError) return;
    clearTimeout(loadTimeout);
    setProgress(100);
    statusEl.textContent = 'Ready.';
    setTimeout(() => {
      splashEl.classList.add('hidden');
      document.getElementById('app').classList.add('ready');
    }, 350);
  };
})();
