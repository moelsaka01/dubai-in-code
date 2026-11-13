// A full-page message for failures that leave nothing to look at: no WebGL 2, or city data that did not load.
// Keeps the page from sitting blank under a "Loading" line. The OSM credit stays (it is not part of the overlay).

/** True when the browser can create a WebGL 2 context (three.js needs it). */
export function hasWebGL2() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    return !!gl;
  } catch {
    return false;
  }
}

/** Show `message` (and an optional smaller `detail`) in the middle of the page and stop the loading bar. */
export function showFatal(message, detail = '') {
  const status = document.getElementById('status');
  if (status) status.textContent = message;
  document.getElementById('loading')?.classList.add('done');
  document.body.classList.add('failed');

  let el = document.getElementById('fatal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal';
    el.setAttribute('role', 'alert');
    document.body.appendChild(el);
  }
  el.replaceChildren();
  const p = document.createElement('p');
  p.textContent = message;
  el.appendChild(p);
  if (detail) {
    const d = document.createElement('p');
    d.className = 'detail';
    d.textContent = detail;
    el.appendChild(d);
  }
}
