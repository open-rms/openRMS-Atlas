// Serializer for the Winlink-compatible gateway status feed.
//
// Shape matches https://api.winlink.org/gateway/status.json as read by Pat
// (internal/cmsapi), EmComm Tools (jq on Pat's rmslist.json) and others:
// PascalCase keys, Frequency in Hz, Timestamp as "\/Date(ms)\/", LastStatus in
// Go's time.RFC1123 layout with "UTC". Any field Pat cannot decode fails the
// whole list in Pat, so every value here is defensive.
import type { GatewayView, ChannelView } from "../data.js";
import { getModem } from "../modes.js";
import { gridToLatLon } from "../lib/callsign.js";

export interface WinlinkChannel {
  Timestamp: string;
  SupportedModes: string;
  Mode: number;
  Gridsquare: string;
  Frequency: number;
  OperatingHours: string;
  Baud: string;
  RadioRange: string;
  Antenna: string;
  ServiceCode: string;
  OpenRMS?: { modem: string; variant: string | null; modemVersion: string | null };
}

export interface WinlinkGateway {
  Timestamp: string;
  Callsign: string;
  BaseCallsign: string;
  Latitude: number;
  Longitude: number;
  HoursSinceStatus: number;
  LastStatus: string;
  Comments: string;
  RequestedMode: string;
  GatewayChannels: WinlinkChannel[];
  OpenRMS?: { id: string; source: string; status: string; ownerVerified: boolean; url?: string };
}

export interface WinlinkStatusDoc {
  Gateways: WinlinkGateway[];
  ResponseStatus: Record<string, never>;
}

export type RequestedMode = "AnyAll" | "Packet" | "Pactor" | "RobustPacket" | "AllHf";

export interface CompatQuery {
  mode: RequestedMode;
  historyHours: number;
  serviceCodes: string[];
  extensions: boolean;
  /** Leave out owner listings whose callsign is not verified yet. */
  requireVerified?: boolean;
  publicBaseUrl?: string;
}

export function parseRequestedMode(s: string | undefined): RequestedMode {
  switch ((s ?? "").toLowerCase()) {
    case "packet": return "Packet";
    case "pactor": return "Pactor";
    case "robustpacket": return "RobustPacket";
    case "allhf": return "AllHf";
    default: return "AnyAll";
  }
}

/** "Sun, 01 Nov 2026 07:53:00 UTC" (Go time.RFC1123 with UTC zone). */
export function rfc1123(d: Date): string {
  return d.toUTCString().replace(/GMT$/, "UTC");
}

export function dotnetDate(d: Date): string {
  return `/Date(${d.getTime()})/`;
}

function modeMatches(rm: RequestedMode, ch: ChannelView): boolean {
  switch (rm) {
    case "AnyAll": return true;
    case "Packet": return ch.modem === "packet";
    case "Pactor": return ch.modem === "pactor";
    case "RobustPacket": return ch.modem === "robust-packet";
    case "AllHf": return ch.frequencyHz < 30_000_000;
  }
}

/** Service codes everyone's clients use with stock VARA/ARDOP. A borrowed-protocol mode never lands under these. */
export const STANDARD_CODES = new Set(["PUBLIC", "EMCOMM"]);

/** The channel's stored codes: its main code first, then the extra ones, uppercased and de-duplicated. */
export function storedServiceCodes(ch: ChannelView): string[] {
  return [...new Set([ch.serviceCode, ...(ch.extraServiceCodes ?? [])].map((c) => c.trim().toUpperCase()).filter(Boolean))];
}

/** How one channel appears in the compat feed, or null when no client could dial it. */
export function compatChannel(gw: GatewayView, ch: ChannelView): { supportedModes: string; mode: number; serviceCodes: string[] } | null {
  if (gw.source === "winlink" && ch.winlinkSupportedModes) {
    return { supportedModes: ch.winlinkSupportedModes, mode: ch.winlinkMode ?? 0, serviceCodes: [ch.serviceCode.toUpperCase()] };
  }
  const modem = getModem(ch.modem);
  const rule = modem?.compat(ch.variant) ?? null;
  const override = ch.compatSupportedModes?.trim();
  // Modes that borrow another modem's host protocol (Mercury, XARA, Data2G) get their own code
  // in place of PUBLIC/EMCOMM, so default clients never dial a gateway their modem can't reach.
  // Custom (group) codes stay as the sysop typed them: the group knows what it is dialing.
  const forced = override
    ? rule?.serviceCode ?? (modem?.winlinkNative ? undefined : ch.modem.toUpperCase().replace(/-/g, ""))
    : rule?.serviceCode;
  const codes = (list: string[]) => [...new Set(list.map((c) => (forced && STANDARD_CODES.has(c) ? forced : c)))];
  if (override) return { supportedModes: override, mode: rule?.mode ?? 9999, serviceCodes: codes(storedServiceCodes(ch)) };
  if (!rule || !rule.supportedModes.trim()) return null; // Pat panics on an empty SupportedModes
  return { supportedModes: rule.supportedModes, mode: rule.mode, serviceCodes: codes(storedServiceCodes(ch)) };
}

/**
 * The service codes a channel is published under: the compat feed's codes, or the stored codes
 * for channels the feed leaves out. Mercury/XARA/Data2G typed as PUBLIC count as their own code.
 */
export function feedServiceCodes(gw: GatewayView, ch: ChannelView): string[] {
  return compatChannel(gw, ch)?.serviceCodes ?? storedServiceCodes(ch);
}

export function toWinlinkStatus(gateways: GatewayView[], query: CompatQuery, now = new Date()): WinlinkStatusDoc {
  const codes = new Set(query.serviceCodes.map((c) => c.trim().toUpperCase()).filter(Boolean));
  if (codes.size === 0) codes.add("PUBLIC");
  const out: WinlinkGateway[] = [];

  for (const gw of gateways) {
    if (gw.hidden || gw.unverifiedConflict) continue;
    if (query.requireVerified && gw.source === "openrms" && !gw.ownerVerified) continue;
    const lastSeen = gw.lastSeenAt ? new Date(gw.lastSeenAt) : null;
    const hoursSince = lastSeen ? Math.max(0, Math.floor((now.getTime() - lastSeen.getTime()) / 3.6e6)) : null;
    // Hand-confirmed openRMS listings have no hourly status; they stay in the feed while "listed".
    const inWindow = gw.status === "listed" || (hoursSince !== null && hoursSince <= query.historyHours);
    if (!inWindow) continue;

    const channels: WinlinkChannel[] = [];
    for (const ch of gw.channels) {
      if (!modeMatches(query.mode, ch)) continue;
      const c = compatChannel(gw, ch);
      if (!c) continue;
      // One entry per requested code the channel carries, the way Winlink lists them.
      for (const code of c.serviceCodes) {
        if (!codes.has(code)) continue;
        const stamp = lastSeen ?? new Date(gw.updatedAt);
        channels.push({
          Timestamp: dotnetDate(stamp),
          SupportedModes: c.supportedModes,
          Mode: c.mode,
          Gridsquare: ch.gridsquare || gw.gridsquare || "",
          Frequency: Math.round(ch.frequencyHz),
          OperatingHours: ch.operatingHours || "00-23",
          Baud: ch.baud || "0",
          RadioRange: ch.radioRange || "",
          Antenna: ch.antenna || "",
          ServiceCode: code,
          ...(query.extensions ? { OpenRMS: { modem: ch.modem, variant: ch.variant, modemVersion: ch.modemVersion } } : {}),
        });
      }
    }
    if (channels.length === 0) continue;

    let lat = gw.latitude, lon = gw.longitude;
    if (lat == null || lon == null) {
      const c = gridToLatLon(channels[0]!.Gridsquare);
      if (!c) continue; // no position at all: clients that map gateways would misplace it
      lat = c.lat;
      lon = c.lon;
    }
    const stamp = lastSeen ?? new Date(gw.updatedAt);
    out.push({
      Timestamp: dotnetDate(stamp),
      Callsign: gw.callsign,
      BaseCallsign: gw.baseCallsign,
      Latitude: lat,
      Longitude: lon,
      HoursSinceStatus: hoursSince ?? 0,
      LastStatus: rfc1123(stamp),
      Comments: gw.comments ?? "",
      RequestedMode: query.mode,
      GatewayChannels: channels,
      ...(query.extensions
        ? {
            OpenRMS: {
              id: gw.id,
              source: gw.source,
              status: gw.status,
              ownerVerified: gw.ownerVerified,
              ...(query.publicBaseUrl ? { url: `${query.publicBaseUrl}/api/v1/gateways/${gw.id}` } : {}),
            },
          }
        : {}),
    });
  }
  return { Gateways: out, ResponseStatus: {} };
}

/** JSON text with Winlink's escaped "\/Date(...)\/" timestamps. */
export function stringifyWinlink(doc: WinlinkStatusDoc): string {
  return JSON.stringify(doc).replace(/"\/Date\((\d+)\)\/"/g, '"\\/Date($1)\\/"');
}

/** File name Pat uses for its cached list: rmslist.json, or rmslist-CODE1-CODE2.json. */
export function patCacheFileName(serviceCodes: string[]): string {
  const codes = serviceCodes.length ? serviceCodes : ["PUBLIC"];
  return codes.length === 1 && codes[0] === "PUBLIC" ? "rmslist.json" : `rmslist-${codes.join("-")}.json`;
}
