// Entry point. Everything lives in app.js; this only boots it and reports a failed start.
import { createApp } from './app.js';
import { hasWebGL2, showFatal } from './ui/fatal.js';

const canvas = document.getElementById('scene');
if (!hasWebGL2()) {
  showFatal(
    'This browser cannot run the 3D view: WebGL 2 is not available.',
    'Try a recent Chrome, Edge, Firefox or Safari, and check that hardware acceleration is turned on.',
  );
} else {
  try {
    const app = createApp(canvas);
    app.ready.catch(() => {}); // already reported on the page and in the console
    window.__dubai = app; // for the console: __dubai.stats(), __dubai.env.setTime(0.9)
  } catch (err) {
    console.error(err);
    showFatal('The 3D view could not start.', String(err && err.message ? err.message : err));
  }
}
