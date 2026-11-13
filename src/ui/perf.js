// The ?perf overlay: draw calls, triangles, smoothed frame time, render scale and quality level.
// Numbers come from app.stats() and app.res, so the overlay and window.__dubai always agree.

/**
 * @param {() => {calls:number, triangles:number}} getStats
 * @param {() => {scale:number}} getRes
 * @param {() => string} getLevel
 */
export function createPerf(getStats, getRes, getLevel) {
  const el = document.createElement('div');
  el.id = 'perf';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', 'Performance');
  document.body.appendChild(el);

  let smooth = 0, shown = 0;
  return {
    /** Call once per frame with the frame time in ms. */
    tick(ms, now) {
      if (ms > 0 && ms < 250) smooth = smooth ? smooth * 0.92 + ms * 0.08 : ms;
      if (now - shown < 250) return; // redraw the text four times a second
      shown = now;
      const s = getStats();
      const fps = smooth ? Math.round(1000 / smooth) : 0;
      el.textContent =
        `${smooth.toFixed(1)} ms  ${fps} fps\n` +
        `${s.calls} calls  ${(s.triangles / 1000).toFixed(0)} K tris\n` +
        `scale ${getRes().scale.toFixed(2)}  ${getLevel()}`;
    },
  };
}
