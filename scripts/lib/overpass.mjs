// Minimal Overpass client: descriptive User-Agent, polite spacing, backoff on 429/502/504, file cache.
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'dubai-in-code/0.1 (open-source OSM 3D visualisation; non-commercial)';
const BACKOFF_S = [15, 30, 60, 120];
const SPACING_MS = 10_000;
let lastRequestAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST a query. Returns parsed JSON. Retries with backoff on 429/502/504 and on HTML bodies. */
export async function overpass(query, label = 'query') {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    let status = 0;
    let text = '';
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'data=' + encodeURIComponent(query),
      });
      status = res.status;
      text = await res.text();
      if (status === 200 && text.trimStart().startsWith('{')) {
        const json = JSON.parse(text);
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error('remark: ' + json.remark);
        return json;
      }
    } catch (e) {
      text = String(e.message || e);
    }
    const retryable = status === 0 || status === 200 || status === 429 || status === 502 || status === 503 || status === 504;
    if (!retryable || attempt >= BACKOFF_S.length) {
      throw new Error(`${label}: HTTP ${status} after ${attempt + 1} attempts: ${text.slice(0, 200)}`);
    }
    const s = BACKOFF_S[attempt];
    console.log(`  ${label}: HTTP ${status}, retry in ${s}s`);
    await sleep(s * 1000);
  }
}

/** Fetch unless cached. Returns true if a request was made. */
export async function fetchCached(path, query, label, force = false) {
  if (!force && existsSync(path) && statSync(path).size > 20) {
    console.log(`cached  ${label}`);
    return false;
  }
  console.log(`fetch   ${label} ...`);
  const json = await overpass(query, label);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(json));
  console.log(`saved   ${label}: ${json.elements.length} elements, ${(statSync(path).size / 1e6).toFixed(1)} MB (osm ${json.osm3s?.timestamp_osm_base ?? '?'})`);
  return true;
}
