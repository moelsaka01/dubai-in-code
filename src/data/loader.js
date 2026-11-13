// Loads public/data: the JSON files on the main thread, land and tiles through the tile worker.
// The main thread only receives typed arrays and wraps them in BufferGeometry.
import { TILE_SIZE, GRID_MIN } from '../shared/config.js';

const IN_FLIGHT = 4;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Fetch manifest, landmarks and traffic. Returns them with a `stream()` that loads land and all tiles. */
export async function openCity() {
  const base = new URL('data/', document.baseURI);
  const [manifest, landmarks, traffic] = await Promise.all(
    ['manifest.json', 'landmarks.json', 'traffic.json'].map((f) => getJson(new URL(f, base))),
  );
  // Bridge heights are an extra: without the file bridges still rise, they just do not join across tiles.
  const bridges = await getJson(new URL('bridges.json', base)).catch(() => ({ step: 8, nodes: [], traffic: [] }));

  /**
   * @param {{ focus: [number, number], onLand: Function, onTile: Function, onProgress: Function }} h
   *   focus = (east, north) the camera starts near; tiles load nearest first.
   */
  function stream({ focus, onLand, onTile, onProgress }) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'bridges', nodes: bridges.nodes });
      const centre = (t) => [GRID_MIN + (t.tx + 0.5) * TILE_SIZE, GRID_MIN + (t.ty + 0.5) * TILE_SIZE];
      const dist = (t) => { const c = centre(t); return Math.hypot(c[0] - focus[0], c[1] - focus[1]); };
      const queue = manifest.tiles.slice().sort((a, b) => dist(a) - dist(b))
        .map((t) => ({ type: 'tile', id: t.id, url: new URL(`tiles/${t.id}.bin`, base).href }));
      queue.unshift({ type: 'land', id: 'land', url: new URL('land.bin', base).href });
      const total = queue.length;
      let done = 0, flying = 0, failed = 0;

      const pump = () => {
        while (flying < IN_FLIGHT && queue.length) {
          worker.postMessage(queue.shift());
          flying++;
        }
        if (!flying && !queue.length) {
          worker.terminate();
          resolve({ total, failed });
        }
      };
      worker.onmessage = (e) => {
        const m = e.data;
        flying--;
        done++;
        if (m.type === 'tile') onTile(m);
        else if (m.type === 'land') onLand(m);
        else { failed++; console.error(`[loader] ${m.id}: ${m.message}`); }
        onProgress(done / total);
        pump();
      };
      worker.onerror = (e) => reject(new Error(`tile worker failed: ${e.message}`));
      pump();
    });
  }

  return { manifest, landmarks: landmarks.landmarks, traffic, bridges, stream };
}
