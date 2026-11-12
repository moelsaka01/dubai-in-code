// Single source of truth for geography. Imported by the data pipeline (Node) and the app (browser).
// Keep this file free of browser-only and Node-only APIs.

/** Projection origin: centre of the world bbox. */
export const ORIGIN = { lat: 25.145, lon: 55.1975 };

/** Metres per degree at ORIGIN.lat (WGS84 series). Error stays under ~2 m across the scene. */
export const M_PER_DEG_LAT = 110775;
export const M_PER_DEG_LON = 100831;

/** Bounding boxes as [south, west, north, east], the order Overpass expects. */
export const BBOX = {
  world: [25.055, 55.095, 25.235, 55.3],
  marina: [25.06, 55.11, 25.1, 55.16],
  palm: [25.095, 55.1, 25.147, 55.165],
  downtown: [25.178, 55.25, 25.228, 55.295],
  baa: [25.128, 55.178, 25.148, 55.2],
  land: [24.935, 54.975, 25.355, 55.42],
};

/** Tier A = marina, palm, downtown, baa, plus this buffer (metres) around Sheikh Zayed Road. */
export const SZR_BUFFER_M = 600;
export const TIER_B_MIN_AREA_M2 = 120;

/** Tile grid in local metres: 12 x 12 tiles of 2 km, covering -12 km..+12 km on both axes. */
export const TILE_SIZE = 2000;
export const GRID_MIN = -12000;
export const GRID_N = 12;

/** Landmarks replaced by procedural models. `clear` = radius (m) in which OSM buildings are dropped. */
export const LANDMARKS = {
  burjKhalifa: { name: 'Burj Khalifa', lat: 25.19704, lon: 55.27421, height: 828, clear: 95, osm: 'way/446646206' },
  cayan: { name: 'Cayan Tower', lat: 25.08685, lon: 55.14517, height: 306, clear: 35, osm: 'way/195527255' },
  museumFuture: { name: 'Museum of the Future', lat: 25.21896, lon: 55.28206, height: 77, clear: 60, osm: 'way/33875310' },
  ainDubai: { name: 'Ain Dubai', lat: 25.08005, lon: 55.12379, height: 250, clear: 130, osm: 'way/1047288986' },
  // Resolved in Phase 2 (task 2.2): the OSM name tag is Arabic (name:en = 'Jumeirah Burj Al Arab'), so Q6 only hit a node. Footprint centroid from way 12700546, which carries height=321.
  burjAlArab: { name: 'Burj Al Arab', lat: 25.1412, lon: 55.18556, height: 321, clear: 70, osm: 'way/12700546' },
};

/** lat/lon (degrees) -> [east, north] in metres from ORIGIN. */
export function project(lat, lon) {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, (lat - ORIGIN.lat) * M_PER_DEG_LAT];
}

/** [east, north] in metres -> { lat, lon }. */
export function unproject(east, north) {
  return { lat: ORIGIN.lat + north / M_PER_DEG_LAT, lon: ORIGIN.lon + east / M_PER_DEG_LON };
}

/** Tile indices for a point in local metres. May fall outside 0..GRID_N-1 for points beyond the grid. */
export function tileOf(east, north) {
  return [Math.floor((east - GRID_MIN) / TILE_SIZE), Math.floor((north - GRID_MIN) / TILE_SIZE)];
}

/** Scene convention: x = east, y = up, z = -north. */
export function toScene(east, north, up = 0) {
  return [east, up, -north];
}
