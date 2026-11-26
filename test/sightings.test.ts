import { describe, expect, it } from "vitest";
import { buildSightings, type Obs } from "../src/watch/sightings.js";
import { crcHex } from "../src/lib/crc.js";
import type { GatewayView } from "../src/data.js";

// Find two callsigns that share a CRC16, to test collision handling.
function collidingPair(): [string, string] {
  const seen = new Map<string, string>();
  for (let n = 0; n < 200000; n++) {
    const call = `W${n % 10}A${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(65 + Math.floor(n / 26) % 26)}-${Math.floor(n / 676) % 16}`;
    const k = crcHex(call);
    const prev = seen.get(k);
    if (prev && prev !== call) return [prev, call];
    seen.set(k, call);
  }
  throw new Error("no collision found");
}

const gw = (callsign: string, mercuryCentres: number[], other: number[] = []): GatewayView =>
  ({
    id: `id-${callsign}`, source: "openrms", callsign, baseCallsign: callsign.split("-")[0]!, hidden: false,
    channels: [
      ...mercuryCentres.map((f) => ({ modem: "mercury", frequencyHz: f })),
      ...other.map((f) => ({ modem: "ardop", frequencyHz: f })),
    ],
  }) as unknown as GatewayView;

const T0 = Date.parse("2026-11-25T20:00:00Z");
const ob = (crc: string, dial: number, extra: Partial<Obs> = {}): Obs => ({
  crc, dial, ts: T0, heard: true, watcherId: "w1", userId: "u1", verified: true, snr: 10, client: "C492", heardCall: null, ...extra,
});

describe("sightings", () => {
  it("names a unique CRC and clusters frames within ±80 Hz", () => {
    const g = gw("W1RMS-10", [7101500]);
    const s = buildSightings([ob("3DEF", 7100000), ob("3DEF", 7100050), ob("3DEF", 7100500)], [g]);
    expect(s.length).toBe(2);
    const near = s.find((x) => x.frames === 2)!;
    expect(near.resolution).toBe("unique");
    expect(near.callsign).toBe("W1RMS-10");
    expect(near.band).toBe("40m");
  });

  it("narrows a CRC collision by listed Mercury frequency", () => {
    const [a, b] = collidingPair();
    expect(crcHex(a)).toBe(crcHex(b));
    const gws = [gw(a, [7101500]), gw(b, [14105500])];
    const s = buildSightings([ob(crcHex(a), 14104000)], gws);
    expect(s[0]).toMatchObject({ resolution: "unique", callsign: b });
  });

  it("reports ambiguity instead of guessing", () => {
    const [a, b] = collidingPair();
    const s = buildSightings([ob(crcHex(a), 3585000)], [gw(a, [7101500]), gw(b, [14105500])]);
    expect(s[0]!.resolution).toBe("ambiguous");
    expect(s[0]!.callsign).toBeNull();
    expect(s[0]!.candidates.map((c) => c.callsign).sort()).toEqual([a, b].sort());
  });

  it("a callsign heard in clear (CQ) settles a collision", () => {
    const [a, b] = collidingPair();
    const s = buildSightings([ob(crcHex(a), 3585000, { heardCall: b })], [gw(a, [7101500]), gw(b, [14105500])]);
    expect(s[0]).toMatchObject({ resolution: "unique", callsign: b });
  });

  it("an unlisted CRC is unknown, named only if heard in clear", () => {
    expect(buildSightings([ob("ABCD", 7100000)], [])[0]).toMatchObject({ resolution: "unknown", callsign: null });
    const s = buildSightings([ob(crcHex("N0NEW"), 7100000, { heardCall: "N0NEW" })], []);
    expect(s[0]).toMatchObject({ resolution: "unknown", callsign: "N0NEW" });
  });

  it("confirmed needs two verified accounts within 10 minutes", () => {
    const g = [gw("W1RMS-10", [7101500])];
    const one = buildSightings([ob("3DEF", 7100000), ob("3DEF", 7100000, { watcherId: "w2", ts: T0 + 60_000 })], g);
    expect(one[0]!.confidence).toBe("single"); // same account, two watchers
    const two = buildSightings([ob("3DEF", 7100000), ob("3DEF", 7100000, { watcherId: "w2", userId: "u2", ts: T0 + 60_000 })], g);
    expect(two[0]!.confidence).toBe("confirmed");
    const unverified = buildSightings([ob("3DEF", 7100000), ob("3DEF", 7100000, { watcherId: "w2", userId: "u2", verified: false })], g);
    expect(unverified[0]!.confidence).toBe("single");
    const late = buildSightings([ob("3DEF", 7100000), ob("3DEF", 7100000, { watcherId: "w2", userId: "u2", ts: T0 + 11 * 60_000 })], g);
    expect(late[0]!.confidence).toBe("single");
  });

  it("a CALL alone is 'called', not heard", () => {
    const s = buildSightings([ob("3DEF", 7100000, { heard: false })], [gw("W1RMS-10", [7101500])]);
    expect(s[0]).toMatchObject({ heard: false, confidence: "called" });
  });
});
