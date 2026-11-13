// Plain DOM overlay: status line, loading bar, time slider, tour button, quality toggle, landmark chips.
// The OSM credit lives in index.html and is never hidden (not even by H, which hides everything else).

export function createUI({ onTime, onTour, onQuality, onLandmark }) {
  const $ = (id) => document.getElementById(id);
  const status = $('status'), loading = $('loading'), bar = $('loading-bar');
  const slider = $('time'), tourButton = $('tour');
  const qualityButtons = [...document.querySelectorAll('#quality button')];

  slider.addEventListener('input', () => onTime(parseFloat(slider.value)));
  tourButton.addEventListener('click', () => onTour());
  for (const b of qualityButtons) b.addEventListener('click', () => onQuality(b.dataset.quality));
  for (const b of document.querySelectorAll('#chips button')) b.addEventListener('click', () => onLandmark(b.dataset.landmark));

  // H hides the overlay for recording. The OSM credit is not part of it and stays visible.
  let hidden = false;
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyH' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    hidden = !hidden;
    document.body.classList.toggle('hud-hidden', hidden);
  });

  return {
    /** Keys that must not skip the tour. */
    isHudKey(e) {
      return e.code === 'KeyH';
    },
    /** Elements that should not count as "the user touched the scene". */
    isControl(target) {
      return target instanceof Element && !!target.closest('#panel, #chips, #credit');
    },
    setStatus(text) {
      status.textContent = text;
    },
    setProgress(f) {
      const pct = Math.round(f * 100);
      bar.style.width = `${pct}%`;
      loading.setAttribute('aria-valuenow', String(pct));
      loading.classList.toggle('done', f >= 1);
    },
    setTime(t) {
      slider.value = String(t);
    },
    setTourPlaying(playing) {
      tourButton.textContent = playing ? 'Stop tour' : 'Play tour';
      tourButton.setAttribute('aria-pressed', String(playing));
    },
    setQuality(level) {
      for (const b of qualityButtons) b.setAttribute('aria-pressed', String(b.dataset.quality === level));
    },
  };
}
