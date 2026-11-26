// Writes fixtures/winlink-gateway-status.sample.json.gz: a synthetic gateway list in the exact
// shape of api.winlink.org's gateway/status.json, for development imports and the compat tests.
// No real stations: every callsign uses the unallocated Q prefix (Q0AAA-10, ...) and the
// locations, frequencies and comments are random. Deterministic (seeded), so rerunning it
// produces the same file.
//
//   pnpm exec tsx scripts/make-winlink-fixture.ts
//
// It covers what the tests rely on: every SupportedModes string Winlink uses with its Mode code
// and Baud values, multi-channel gateways, channel timestamps that differ from the gateway's,
// per-channel gridsquares, odd operating hours and antennas, comments with characters that need
// escaping, gateways with and without an SSID, and a few outside the 48-hour compat window.
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const COUNT = 1000;
const NOW = Date.UTC(2026, 10, 1, 8, 0, 0); // 2026-11-01T08:00Z, the newest LastStatus

// Mulberry32: small seeded PRNG.
let seed = 0x0badc0de;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const weighted = <T>(xs: readonly [T, number][]): T => {
  let r = rand() * xs.reduce((s, [, w]) => s + w, 0);
  for (const [x, w] of xs) if ((r -= w) < 0) return x;
  return xs[0]![0];
};

// SupportedModes → Mode code, Baud values seen in Winlink's list, band ("hf" | "vhf").
const MODES: [string, number, string[], "hf" | "vhf", number][] = [
  ["VARA", 50, ["0", "600"], "hf", 8],
  ["VARA 500", 53, ["0", "600"], "hf", 2],
  ["VARA 2750", 54, ["0", "600"], "hf", 6],
  ["VARA FM", 51, ["0", "1200"], "vhf", 10],
  ["VARA FM WIDE", 52, ["0", "9600"], "vhf", 8],
  ["ARDOP 500", 41, ["600"], "hf", 1],
  ["ARDOP 1000", 42, ["0"], "hf", 1],
  ["ARDOP 2000", 43, ["0", "600"], "hf", 4],
  ["Packet 1200", 0, ["0", "1200", "300"], "vhf", 12],
  ["Packet 2400", 1, ["2400"], "vhf", 1],
  ["Packet 4800", 2, ["4800"], "vhf", 1],
  ["Packet 9600", 3, ["9600"], "vhf", 2],
  ["Packet 38400", 5, ["19600"], "vhf", 1],
  ["Pactor 1,2", 12, ["0"], "hf", 1],
  ["Pactor 1,2,3", 13, ["0"], "hf", 1],
  ["Pactor 1,2,3,4", 17, ["0"], "hf", 2],
  ["Pactor 2", 14, ["600"], "hf", 1],
  ["Pactor 2,3", 15, ["600"], "hf", 1],
  ["Pactor 2,3,4", 18, ["600"], "hf", 1],
  ["Pactor 3", 16, ["600"], "hf", 1],
  ["Pactor 3,4", 19, ["0", "600"], "hf", 2],
  ["Robust Packet", 30, ["600"], "hf", 1],
  ["Unknown", 1200, ["1200"], "vhf", 0.3],
];
const HF_KHZ = [[3570, 3620], [5330, 5410], [7040, 7110], [10120, 10150], [14060, 14112], [18100, 18110], [21070, 21120], [24920, 24930], [28100, 28150]];
const VHF_KHZ = [[144900, 145990], [146400, 147500], [223400, 224000], [430000, 449000], [1240000, 1300000]];
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const WORDS = ["Gateway", "EmComm", "Club station", "ARES", "Hilltop site", "Backup power", "Solar", "Generator", "Weekdays", "Nights", "Contact sysop", "Testing", "New antenna", "Low power", "Beam north", "Repeater site"];
const ODD = ["\"quoted\"", "C:\\path\\name", "5° N", "R&D <test>", "it's", "a/b", "50% duty", "~ tilde", "#1", "[note]", "émission", "日本"];

function grid(lat: number, lon: number) {
  const L = lon + 180, A = lat + 90;
  const f = (n: number) => String.fromCharCode(65 + n);
  return f(Math.floor(L / 20)) + f(Math.floor(A / 10)) + Math.floor((L % 20) / 2) + Math.floor(A % 10)
    + f(Math.floor((L % 2) * 12)) + f(Math.floor((A % 1) * 24));
}
function rfc1123(ms: number) {
  const d = new Date(ms);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${mon[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}
const date = (ms: number) => `/Date(${ms})/`;
function comment() {
  if (rand() < 0.73) return "";
  const parts = Array.from({ length: int(1, 3) }, () => pick(WORDS));
  if (rand() < 0.25) parts.push(pick(ODD));
  return parts.join(pick([", ", " - ", "; ", ". ", " / "]));
}
function frequency(band: "hf" | "vhf") {
  if (rand() < 0.003) return int(1, 999); // operator typos exist in the real list
  const [lo, hi] = pick(band === "hf" ? HF_KHZ : VHF_KHZ)!;
  return int(lo!, hi!) * 1000 + pick([0, 0, 0, 500]);
}

const used = new Set<string>();
const gateways = [];
for (let i = 0; i < COUNT; i++) {
  let base: string;
  do base = `Q${int(0, 9)}${Array.from({ length: int(2, 3) }, () => pick([...LETTERS])).join("")}`;
  while (used.has(base));
  used.add(base);
  const ssid = weighted<string>([["-10", 58], ["", 21], ["-11", 7], ["-12", 4], ["-4", 2], ["-5", 2], ["-1", 2], ["-7", 2], ["-15", 2]]);
  const callsign = base + ssid;

  const lat = Math.round((rand() * 140 - 60) * 1e13) / 1e13;
  const lon = Math.round((rand() * 360 - 180) * 1e13) / 1e13;
  const hours = rand() < 0.03 ? int(60, 90) : weighted<number>([[0, 50], [1, 15], [2, 8], [int(3, 12), 15], [int(13, 40), 12]]);
  const last = NOW - (i === 0 ? 0 : hours * 3_600_000 + int(0, 59) * 60_000);
  const gs = grid(lat, lon);

  const nch = weighted<number>([[1, 56], [2, 28], [3, 6], [4, 5], [6, 3], [8, 2]]);
  const channels = Array.from({ length: nch }, () => {
    const [modes, mode, bauds, band] = weighted(MODES.map((m) => [m, m[4]] as [typeof m, number]));
    return {
      Timestamp: date(rand() < 0.07 ? last - int(1, 400) * 86_400_000 : last),
      SupportedModes: modes,
      Mode: mode,
      Gridsquare: rand() < 0.01 ? grid(lat + 1.1, lon) : gs,
      Frequency: frequency(band),
      OperatingHours: rand() < 0.98 ? "00-23" : `${String(int(0, 13)).padStart(2, "0")}-${String(int(4, 23)).padStart(2, "0")}`,
      Baud: pick(bauds),
      RadioRange: weighted<string>([["15", 45], ["11", 25], ["13", 9], ["10", 4], ["7", 3], ["8", 3], [String(int(1, 40)), 11]]),
      Antenna: rand() < 0.995 ? "Omni" : String(int(1, 36) * 10),
      ServiceCode: "PUBLIC",
    };
  });
  gateways.push({
    Timestamp: date(last),
    Callsign: callsign,
    BaseCallsign: base,
    Latitude: lat,
    Longitude: lon,
    HoursSinceStatus: i === 0 ? 0 : hours,
    LastStatus: rfc1123(last),
    Comments: comment(),
    RequestedMode: "AnyAll",
    GatewayChannels: channels,
  });
}

const out = new URL("../fixtures/winlink-gateway-status.sample.json.gz", import.meta.url);
writeFileSync(out, gzipSync(JSON.stringify({ Gateways: gateways, ResponseStatus: {} })));
console.log(`wrote ${gateways.length} gateways, ${gateways.reduce((n, g) => n + g.GatewayChannels.length, 0)} channels`);
