/* ============================================================
   SPLASH SCREEN CONTROLLER
   Displays measured route-preload progress and exposes splash state
   updates to the map initialization code.
   ============================================================ */

(function () {
  const statusEl = document.getElementById('splashStatus');
  const progressBar = document.getElementById('splashProgressBar');
  const splashEl = document.getElementById('splash');
  let hasError = false;
  const retryButton = document.getElementById('splashRetry');

  function setProgress(pct) {
    progressBar.style.width = Math.max(0, Math.min(pct, 100)) + '%';
  }

  window.updateSplashProgress = function (pct, message) {
    if (hasError) return;
    if (message) statusEl.textContent = message;
    setProgress(pct);
  };

  retryButton.addEventListener('click', () => window.location.reload());

  window.showSplashError = function (message) {
    if (hasError) return;
    hasError = true;
    statusEl.textContent = message;
    statusEl.style.opacity = 1;
    retryButton.hidden = false;
    splashEl.classList.remove('hidden');
    splashEl.classList.add('has-error');
    document.getElementById('app').classList.remove('ready');
  };

  window.hideSplashScreen = function () {
    if (hasError) return;
    setProgress(100);
    statusEl.textContent = 'Ready.';
    splashEl.classList.add('hidden');
    document.getElementById('app').classList.add('ready');
  };
})();
