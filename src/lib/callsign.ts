// Amateur callsign helpers. Account callsigns are bare (no SSID, no /P);
// gateway callsigns may carry an SSID (-0..-15) as Winlink lists them.

const BASE = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z]$/;

export function normalizeCallsign(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidBaseCallsign(call: string): boolean {
  return BASE.test(call) && /[A-Z]/.test(call) && call.length <= 10;
}

export function splitGatewayCallsign(input: string): { callsign: string; base: string; ssid: number | null } | null {
  const callsign = normalizeCallsign(input);
  const m = /^([A-Z0-9]+)(?:-(\d{1,2}))?$/.exec(callsign);
  if (!m) return null;
  const base = m[1]!;
  const ssid = m[2] === undefined ? null : Number(m[2]);
  if (!isValidBaseCallsign(base)) return null;
  if (ssid !== null && ssid > 15) return null;
  return { callsign, base, ssid };
}

const GRID = /^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/i;

export function isValidGrid(g: string): boolean {
  return GRID.test(g);
}

/** Maidenhead locator to the centre of its square. */
export function gridToLatLon(grid: string): { lat: number; lon: number } | null {
  if (!isValidGrid(grid)) return null;
  const g = grid.toUpperCase();
  let lon = (g.charCodeAt(0) - 65) * 20 - 180;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90;
  lon += Number(g[2]) * 2;
  lat += Number(g[3]);
  let dLon = 2, dLat = 1;
  if (g.length >= 6) {
    lon += ((g.charCodeAt(4) - 65) * 5) / 60;
    lat += ((g.charCodeAt(5) - 65) * 2.5) / 60;
    dLon = 5 / 60;
    dLat = 2.5 / 60;
  }
  if (g.length >= 8) {
    lon += (Number(g[6]) * 0.5) / 60;
    lat += (Number(g[7]) * 0.25) / 60;
    dLon = 0.5 / 60;
    dLat = 0.25 / 60;
  }
  return { lat: lat + dLat / 2, lon: lon + dLon / 2 };
}

export function latLonToGrid(lat: number, lon: number, len = 6): string {
  const L = lon + 180, A = lat + 90;
  let s = String.fromCharCode(65 + Math.floor(L / 20)) + String.fromCharCode(65 + Math.floor(A / 10));
  s += Math.floor((L % 20) / 2).toString() + Math.floor(A % 10).toString();
  if (len >= 6) {
    s += String.fromCharCode(97 + Math.floor(((L % 2) * 60) / 5)) + String.fromCharCode(97 + Math.floor(((A % 1) * 60) / 2.5));
  }
  return s.slice(0, 4).toUpperCase() + s.slice(4);
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
