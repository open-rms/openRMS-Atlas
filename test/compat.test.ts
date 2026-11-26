import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWinlinkModes, MODEMS } from "../src/modes.js";
import { toWinlinkStatus, stringifyWinlink, rfc1123, patCacheFileName, compatChannel, feedServiceCodes } from "../src/compat/winlink-status.js";
import { filterGateways, publicGateway } from "../src/routes/public.js";
import { projectPublic } from "../src/data.js";
import type { GatewayView, ChannelView } from "../src/data.js";

const fixture = JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/winlink-gateway-status.sample.json.gz", import.meta.url))).toString());

/** Same mapping the importer stores, built in memory. */
function fromWinlink(doc: any): GatewayView[] {
  return doc.Gateways.map((g: any, i: number): GatewayView => ({
    id: String(i), source: "winlink", callsign: g.Callsign, baseCallsign: g.BaseCallsign, ownerUserId: null, ownerVerified: false,
    latitude: g.Latitude, longitude: g.Longitude, gridsquare: g.GatewayChannels[0]?.Gridsquare ?? null, locationPrecision: "exact",
    comments: g.Comments, software: null, winlinkListed: true, club: null, alsoListedBy: [], unverifiedConflict: false, ownerComments: "", claimed: false, claimedAt: null, emcomm: {}, live: {}, hidden: false,
    lastHeartbeatAt: null, confirmedAt: null, lastSeenAt: new Date(g.LastStatus).toISOString(), status: "online",
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    channels: g.GatewayChannels.map((c: any, j: number): ChannelView => {
      const { modem, variant } = parseWinlinkModes(c.SupportedModes, c.ServiceCode);
      return { id: `${i}-${j}`, frequencyHz: c.Frequency, band: null, modem, modemLabel: modem, variant, modemVersion: null,
        serviceCode: c.ServiceCode, extraServiceCodes: [], operatingHours: c.OperatingHours, antenna: c.Antenna, radioRange: c.RadioRange,
        gridsquare: c.Gridsquare, baud: c.Baud, notes: "", winlinkSupportedModes: c.SupportedModes, winlinkMode: c.Mode,
        compatSupportedModes: null };
    }),
  }));
}

const fixtureNow = new Date(Math.max(...fixture.Gateways.map((g: any) => new Date(g.LastStatus).getTime())));
const query = { mode: "AnyAll" as const, historyHours: 48, serviceCodes: ["PUBLIC"], extensions: false };

describe("Winlink mode parsing", () => {
  it("maps every SupportedModes string in the sample to a known modem", () => {
    const unknown = fixture.Gateways.flatMap((g: any) => g.GatewayChannels)
      .filter((c: any) => c.SupportedModes !== "Unknown")
      .filter((c: any) => parseWinlinkModes(c.SupportedModes, c.ServiceCode).modem === "other");
    expect(unknown).toEqual([]);
  });
  it("treats VARA + service code MERCURY as Mercury", () => {
    expect(parseWinlinkModes("VARA", "MERCURY")).toEqual({ modem: "mercury", variant: null });
    expect(parseWinlinkModes("VARA 2750", "PUBLIC")).toEqual({ modem: "vara-hf", variant: "2750" });
    expect(parseWinlinkModes("VARA FM WIDE", "PUBLIC")).toEqual({ modem: "vara-fm", variant: "WIDE" });
  });
  it("treats VARA + service code XARA or DATA2G as XARA or Data2G", () => {
    expect(parseWinlinkModes("VARA", "XARA")).toEqual({ modem: "xara", variant: "2300" });
    expect(parseWinlinkModes("VARA 500", "xara")).toEqual({ modem: "xara", variant: "500" });
    expect(parseWinlinkModes("VARA FM WIDE", "XARA")).toEqual({ modem: "xara", variant: "FM WIDE" });
    expect(parseWinlinkModes("VARA", "DATA2G")).toEqual({ modem: "data2g", variant: "2400" });
    expect(parseWinlinkModes("VARA 500", "DATA2G")).toEqual({ modem: "data2g", variant: "500" });
    expect(parseWinlinkModes("VARA 2750", "DATA2G")).toEqual({ modem: "data2g", variant: "2400" });
  });
  it("native modems round-trip to Winlink's own strings and codes", () => {
    for (const c of fixture.Gateways.flatMap((g: any) => g.GatewayChannels)) {
      const { modem, variant } = parseWinlinkModes(c.SupportedModes, c.ServiceCode);
      const rule = MODEMS.find((m) => m.id === modem)!.compat(variant);
      if (modem === "other") continue;
      expect(rule, c.SupportedModes).toMatchObject({ supportedModes: c.SupportedModes, mode: c.Mode });
    }
  });
});

describe("compat feed", () => {
  it("formats LastStatus like Go's time.RFC1123 in UTC", () => {
    expect(rfc1123(new Date("2026-11-01T07:53:00Z"))).toBe("Sun, 01 Nov 2026 07:53:00 UTC");
  });

  it("re-serializes the Winlink sample field for field", () => {
    const out = JSON.parse(stringifyWinlink(toWinlinkStatus(fromWinlink(fixture), query, fixtureNow)));
    const inWindow = fixture.Gateways.filter((g: any) => g.HoursSinceStatus <= 48);
    expect(out.Gateways.length).toBe(inWindow.length);
    const byCall = new Map(out.Gateways.map((g: any) => [g.Callsign, g]));
    for (const g of inWindow) {
      const o: any = byCall.get(g.Callsign);
      expect(o, g.Callsign).toBeDefined();
      for (const k of ["Callsign", "BaseCallsign", "Latitude", "Longitude", "LastStatus", "Comments"]) expect(o[k], `${g.Callsign}.${k}`).toEqual(g[k]);
      // Winlink computes this against its own clock at generation time; ours uses fixtureNow.
      expect(Math.abs(o.HoursSinceStatus - g.HoursSinceStatus), `${g.Callsign}.HoursSinceStatus`).toBeLessThanOrEqual(1);
      expect(o.GatewayChannels.length).toBe(g.GatewayChannels.length);
      g.GatewayChannels.forEach((c: any, i: number) => {
        const oc = o.GatewayChannels[i];
        for (const k of ["SupportedModes", "Mode", "Gridsquare", "Frequency", "OperatingHours", "Baud", "RadioRange", "Antenna", "ServiceCode"]) expect(oc[k], `${g.Callsign}[${i}].${k}`).toEqual(c[k]);
      });
    }
  });

  it("escapes timestamps as \\/Date(ms)\\/ like Winlink", () => {
    const text = stringifyWinlink(toWinlinkStatus(fromWinlink(fixture).slice(0, 1), query, fixtureNow));
    expect(text).toMatch(/"Timestamp":"\\\/Date\(\d+\)\\\/"/);
  });

  it("never emits empty SupportedModes and hides non-dialable or borrowed-protocol modes from PUBLIC", () => {
    const gw = fromWinlink(fixture)[0]!;
    const mk = (modem: any, extra: Partial<ChannelView> = {}): ChannelView => ({ ...gw.channels[0]!, winlinkSupportedModes: null, modem, variant: null, serviceCode: "PUBLIC", ...extra });
    const own: GatewayView = { ...gw, source: "openrms", channels: [mk("mercury"), mk("data2g"), mk("ardop", { variant: "500" }), mk("other", { compatSupportedModes: "  " })] };
    const pub = toWinlinkStatus([own], query, fixtureNow).Gateways[0]!.GatewayChannels.map((c) => c.SupportedModes);
    expect(pub).toEqual(["ARDOP 500"]);
    const merc = toWinlinkStatus([own], { ...query, serviceCodes: ["PUBLIC", "MERCURY"] }, fixtureNow).Gateways[0]!.GatewayChannels;
    expect(merc.map((c) => [c.SupportedModes, c.ServiceCode])).toEqual([["VARA", "MERCURY"], ["ARDOP 500", "PUBLIC"]]);
    expect(compatChannel(own, mk("modem73"))).toBeNull();
    const xd: GatewayView = { ...own, channels: [mk("xara"), mk("xara", { variant: "FM WIDE" }), mk("data2g", { variant: "500" }), mk("data2g")] };
    expect(toWinlinkStatus([xd], query, fixtureNow).Gateways).toEqual([]);
    const both = toWinlinkStatus([xd], { ...query, serviceCodes: ["PUBLIC", "XARA", "DATA2G"] }, fixtureNow).Gateways[0]!.GatewayChannels;
    expect(both.map((c) => [c.SupportedModes, c.Mode, c.ServiceCode])).toEqual([
      ["VARA", 9006, "XARA"], ["VARA FM WIDE", 9006, "XARA"], ["VARA 500", 9002, "DATA2G"], ["VARA", 9002, "DATA2G"]]);
  });

  it("passes Winlink-listed XARA and DATA2G channels through with their own codes", () => {
    const listed = { Gateways: [{ ...fixture.Gateways[0], GatewayChannels: [
      { ...fixture.Gateways[0].GatewayChannels[0], SupportedModes: "VARA", Mode: 50, ServiceCode: "XARA" },
      { ...fixture.Gateways[0].GatewayChannels[0], SupportedModes: "VARA 500", Mode: 53, ServiceCode: "DATA2G" }] }] };
    const views = fromWinlink(listed);
    expect(views[0]!.channels.map((c) => c.modem)).toEqual(["xara", "data2g"]);
    const out = toWinlinkStatus(views, { ...query, serviceCodes: ["XARA", "DATA2G"] }, fixtureNow).Gateways[0]!.GatewayChannels;
    expect(out.map((c) => [c.SupportedModes, c.Mode, c.ServiceCode])).toEqual([["VARA", 50, "XARA"], ["VARA 500", 53, "DATA2G"]]);
  });

  it("filters by the service code the feed publishes, not the one the sysop typed", () => {
    const gw = fromWinlink(fixture)[0]!;
    const mk = (modem: any, extra: Partial<ChannelView> = {}): ChannelView => ({ ...gw.channels[0]!, winlinkSupportedModes: null, modem, variant: null, serviceCode: "PUBLIC", ...extra });
    const own: GatewayView = { ...gw, source: "openrms", channels: [mk("mercury"), mk("xara"), mk("ardop", { variant: "500" }), mk("modem73")] };
    expect(own.channels.map((c) => feedServiceCodes(own, c))).toEqual([["MERCURY"], ["XARA"], ["PUBLIC"], ["PUBLIC"]]);
    const only = (sc: string) => filterGateways([own], { serviceCode: sc })[0]?.g.channels.map((c) => c.modem) ?? [];
    expect(only("xara")).toEqual(["xara"]);
    expect(only("PUBLIC")).toEqual(["ardop", "modem73"]);
    expect(only("MERCURY,DATA2G")).toEqual(["mercury"]);
    expect(only("DATA2G")).toEqual([]);
  });

  it("lists a channel under every code it carries; borrowed modes swap only the standard codes", () => {
    const gw = fromWinlink(fixture)[0]!;
    const mk = (modem: any, extra: Partial<ChannelView> = {}): ChannelView => ({ ...gw.channels[0]!, winlinkSupportedModes: null, modem, variant: null, serviceCode: "PUBLIC", extraServiceCodes: [], ...extra });
    const own: GatewayView = { ...gw, source: "openrms", channels: [
      mk("ardop", { variant: "500", extraServiceCodes: ["MYGRP"] }),
      mk("mercury", { extraServiceCodes: ["EMCOMM", "MYGRP"] }),
    ] };
    expect(feedServiceCodes(own, own.channels[1]!)).toEqual(["MERCURY", "MYGRP"]);
    const feed = (codes: string[]) => toWinlinkStatus([own], { ...query, serviceCodes: codes }, fixtureNow).Gateways[0]?.GatewayChannels.map((c) => [c.SupportedModes, c.ServiceCode]) ?? [];
    expect(feed(["PUBLIC"])).toEqual([["ARDOP 500", "PUBLIC"]]);
    expect(feed(["PUBLIC", "MYGRP"])).toEqual([["ARDOP 500", "PUBLIC"], ["ARDOP 500", "MYGRP"], ["VARA", "MYGRP"]]);
    expect(feed(["EMCOMM"])).toEqual([]); // a Mercury channel never lands under a standard code
  });

  it("never shows unlisted codes unless the request names them exactly", () => {
    const gw = fromWinlink(fixture)[0]!;
    const pub = new Set(["PUBLIC", "EMCOMM", "MERCURY", "XARA", "DATA2G"]);
    const mk = (extra: Partial<ChannelView>): ChannelView => ({ ...gw.channels[0]!, winlinkSupportedModes: null, modem: "ardop", variant: "500", serviceCode: "PUBLIC", extraServiceCodes: [], ...extra });
    const a: GatewayView = { ...gw, id: "a", callsign: "A1A", source: "openrms", channels: [
      mk({ id: "a1", serviceCode: "MYGRP", extraServiceCodes: ["PUBLIC"] }), mk({ id: "a2", serviceCode: "MYGRP" })] };
    const b: GatewayView = { ...gw, id: "b", callsign: "B1B", source: "openrms", channels: [mk({ id: "b1", serviceCode: "MYGRP" })] };

    const open = projectPublic([a, b], pub);
    expect(open.map((g) => g.callsign)).toEqual(["A1A"]);
    expect(open[0]!.channels.map((c) => [c.id, c.serviceCodes])).toEqual([["a1", ["PUBLIC"]]]);
    const out = publicGateway(open[0]!).channels[0]!;
    expect(out).toMatchObject({ serviceCode: "PUBLIC", feedServiceCode: "PUBLIC", serviceCodes: ["PUBLIC"] });
    expect(JSON.stringify(publicGateway(open[0]!))).not.toContain("MYGRP");

    const asked = projectPublic([a, b], pub, new Set(["MYGRP"]));
    expect(asked.map((g) => g.channels.map((c) => [c.id, c.serviceCodes]))).toEqual([[["a1", ["MYGRP", "PUBLIC"]], ["a2", ["MYGRP"]]], [["b1", ["MYGRP"]]]]);
    expect(filterGateways(asked, { serviceCode: "mygrp" }).map((r) => r.g.callsign)).toEqual(["A1A", "B1B"]);
    // An unknown code and an unlisted code nobody uses give the same answer.
    const none = (code: string) => JSON.stringify(filterGateways(projectPublic([a, b], pub, new Set([code])), { serviceCode: code }));
    expect(none("NOSUCH")).toBe(none("OTHERGRP"));
    expect(none("NOSUCH")).toBe("[]");
  });

  it("names cache files the way Pat does", () => {
    expect(patCacheFileName(["PUBLIC"])).toBe("rmslist.json");
    expect(patCacheFileName(["PUBLIC", "MERCURY"])).toBe("rmslist-PUBLIC-MERCURY.json");
  });

  const pat = spawnSync("pat", ["version"]).status === 0;
  it.skipIf(!pat)("the real Pat binary prints the same list for our feed as for Winlink's", () => {
    const run = (body: string) => {
      const dir = mkdtempSync(join(tmpdir(), "openrms-pat-"));
      for (const d of ["data/pat", "config/pat", "state/pat"]) mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, "config/pat/config.json"), JSON.stringify({ mycall: "N0CALL", locator: "DN16ra", service_codes: ["PUBLIC"] }));
      writeFileSync(join(dir, "data/pat/rmslist.json"), body);
      const env = { ...process.env, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") };
      return execFileSync("pat", ["rmslist"], { env, encoding: "utf8" });
    };
    const ours = run(stringifyWinlink(toWinlinkStatus(fromWinlink(fixture), { ...query, historyHours: 10_000 }, fixtureNow)));
    const theirs = run(JSON.stringify(fixture));
    expect(ours.split("\n").length).toBeGreaterThan(fixture.Gateways.length);
    expect(ours).toBe(theirs);
  });
});

describe("trust rules in the compat feed", () => {
  const gw = fromWinlink(fixture)[0]!;
  const ch = (extra: Partial<ChannelView>): ChannelView => ({ ...gw.channels[0]!, winlinkSupportedModes: null, serviceCode: "PUBLIC", ...extra });
  const q = { ...query, historyHours: 10_000 };

  it("an owner override on a non-Winlink waveform never lands under PUBLIC", () => {
    const own: GatewayView = { ...gw, source: "openrms", channels: [ch({ modem: "data2g", variant: null, compatSupportedModes: "VARA 2750" })] };
    expect(toWinlinkStatus([own], q, fixtureNow).Gateways).toEqual([]);
    const d2g = toWinlinkStatus([own], { ...q, serviceCodes: ["DATA2G"] }, fixtureNow).Gateways[0]!.GatewayChannels[0]!;
    expect([d2g.SupportedModes, d2g.ServiceCode]).toEqual(["VARA 2750", "DATA2G"]);
  });

  it("an unverified listing that collides with a Winlink callsign stays out of the feed", () => {
    const own: GatewayView = { ...gw, id: "x", source: "openrms", unverifiedConflict: true, channels: [ch({ modem: "ardop", variant: "2000" })] };
    const out = toWinlinkStatus([gw, own], q, fixtureNow).Gateways;
    expect(out.map((g) => g.Callsign)).toEqual([gw.callsign]);
    expect(out[0]!.GatewayChannels[0]!.SupportedModes).toBe(gw.channels[0]!.winlinkSupportedModes);
  });

  it("requireVerified drops unverified owner listings", () => {
    const own: GatewayView = { ...gw, source: "openrms", ownerVerified: false, unverifiedConflict: false, channels: [ch({ modem: "ardop", variant: "2000" })] };
    expect(toWinlinkStatus([own], { ...q, requireVerified: true }, fixtureNow).Gateways).toEqual([]);
    expect(toWinlinkStatus([{ ...own, ownerVerified: true }], { ...q, requireVerified: true }, fixtureNow).Gateways.length).toBe(1);
  });
});

describe("Mercury callsign CRC16", () => {
  it("matches on-air vectors (openRMS-Watch src/crc.rs)", async () => {
    const { crcHex } = await import("../src/lib/crc.js");
    expect(crcHex("W1RMS-10")).toBe("3DEF");
    expect(crcHex("K7TEST")).toBe("C492");
    expect(crcHex("w1rms-10")).toBe("3DEF");
  });
});
