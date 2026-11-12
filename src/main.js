// Entry point. Everything lives in app.js; this only boots it and reports a failed start.
import { createApp } from './app.js';

const canvas = document.getElementById('scene');
try {
  const app = createApp(canvas);
  app.ready.catch(() => {}); // already reported in the status line and the console
  window.__dubai = app; // for the console: __dubai.stats(), __dubai.env.setTime(0.9)
} catch (err) {
  console.error(err);
  document.getElementById('status').textContent = 'This browser could not start WebGL.';
}
