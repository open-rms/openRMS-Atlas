// Modem registry: the real over-the-air waveform of a channel, and how it is
// represented in the Winlink-compatible feed that Pat and other clients read.
//
// The authoritative copy of the openRMS mode codes is
// openRMS-Spec/atlas/modes.md. Keep both in sync.

export type ModemId =
  | "packet"
  | "robust-packet"
  | "pactor"
  | "ardop"
  | "vara-hf"
  | "vara-fm"
  | "mercury"
  | "xara"
  | "data2g"
  | "modem73"
  | "ion-hf"
  | "freedata"
  | "other";

export interface CompatRule {
  /** SupportedModes string Pat can dial. Pat derives its transport from it. */
  supportedModes: string;
  /** Winlink `Mode` integer for this string, or an openRMS code (>= 9000). */
  mode: number;
  /**
   * Service code forced in the compat feed. Used for modes that borrow another
   * mode's host protocol (Mercury speaks the VARA host protocol), so that
   * clients asking only for PUBLIC never get a gateway they cannot reach.
   */
  serviceCode?: string;
}

export interface Modem {
  id: ModemId;
  label: string;
  /** Variants are bandwidth or speed labels, e.g. "500", "2750", "1200", "WIDE". */
  variants: string[];
  defaultVariant?: string;
  band: "hf" | "vhf" | "any";
  homepage?: string;
  /** Winlink-native: Winlink itself lists this waveform. */
  winlinkNative: boolean;
  /** Returns how a channel of this modem appears in the compat feed, or null if Pat cannot dial it. */
  compat: (variant: string | null) => CompatRule | null;
}

// Winlink's own SupportedModes strings and Mode integers, as seen in the
// api.winlink.org gateway/status.json feed (sample of 2026-11-01).
const WINLINK_MODES: Record<string, number> = {
  "Packet 1200": 0,
  "Packet 2400": 1,
  "Packet 4800": 2,
  "Packet 9600": 3,
  "Packet 19200": 4,
  "Packet 38400": 5,
  "Pactor 1": 11,
  "Pactor 1,2": 12,
  "Pactor 1,2,3": 13,
  "Pactor 2": 14,
  "Pactor 2,3": 15,
  "Pactor 3": 16,
  "Pactor 1,2,3,4": 17,
  "Pactor 2,3,4": 18,
  "Pactor 3,4": 19,
  "Pactor 4": 20,
  "Robust Packet": 30,
  "ARDOP 200": 40,
  "ARDOP 500": 41,
  "ARDOP 1000": 42,
  "ARDOP 2000": 43,
  "ARDOP 2000 FM": 44,
  VARA: 50,
  "VARA FM": 51,
  "VARA FM WIDE": 52,
  "VARA 500": 53,
  "VARA 2750": 54,
};

/** openRMS mode codes. Above Winlink's range so no client mistakes them for Winlink modes. */
export const OPENRMS_MODE_CODES = {
  mercury: 9001,
  data2g: 9002,
  modem73: 9003,
  "ion-hf": 9004,
  freedata: 9005,
  xara: 9006,
  other: 9999,
} as const;

function native(s: string): CompatRule | null {
  const mode = WINLINK_MODES[s];
  return mode === undefined ? null : { supportedModes: s, mode };
}

export const MODEMS: Modem[] = [
  {
    id: "packet",
    label: "AX.25 Packet",
    variants: ["1200", "2400", "4800", "9600", "19200", "38400"],
    defaultVariant: "1200",
    band: "any",
    winlinkNative: true,
    compat: (v) => native(`Packet ${v ?? "1200"}`),
  },
  {
    id: "robust-packet",
    label: "Robust Packet",
    variants: [],
    band: "hf",
    winlinkNative: true,
    compat: () => native("Robust Packet"),
  },
  {
    id: "pactor",
    label: "PACTOR",
    variants: ["1", "1,2", "1,2,3", "2", "2,3", "3", "1,2,3,4", "2,3,4", "3,4", "4"],
    defaultVariant: "1,2,3,4",
    band: "hf",
    winlinkNative: true,
    compat: (v) => native(`Pactor ${v ?? "1,2,3,4"}`),
  },
  {
    id: "ardop",
    label: "ARDOP",
    variants: ["200", "500", "1000", "2000", "2000 FM"],
    defaultVariant: "2000",
    band: "any",
    homepage: "https://github.com/pflarue/ardop",
    winlinkNative: true,
    compat: (v) => native(`ARDOP ${v ?? "2000"}`),
  },
  {
    id: "vara-hf",
    label: "VARA HF",
    variants: ["500", "2300", "2750"],
    defaultVariant: "2300",
    band: "hf",
    winlinkNative: true,
    compat: (v) => native(!v || v === "2300" ? "VARA" : `VARA ${v}`),
  },
  {
    id: "vara-fm",
    label: "VARA FM",
    variants: ["NARROW", "WIDE"],
    defaultVariant: "NARROW",
    band: "vhf",
    winlinkNative: true,
    compat: (v) => native(v === "WIDE" ? "VARA FM WIDE" : "VARA FM"),
  },
  {
    id: "mercury",
    label: "Mercury",
    variants: [],
    band: "hf",
    homepage: "https://github.com/Rhizomatica/mercury",
    winlinkNative: false,
    // Mercury speaks the VARA host protocol, so Pat's VARA HF transport drives it.
    // Same convention Mercury gateways use on Winlink: VARA + service code MERCURY.
    compat: () => ({ supportedModes: "VARA", mode: OPENRMS_MODE_CODES.mercury, serviceCode: "MERCURY" }),
  },
  {
    id: "xara",
    label: "XARA",
    variants: ["500", "2300", "2750", "FM NARROW", "FM WIDE"],
    defaultVariant: "2300",
    band: "any",
    homepage: "https://github.com/NR5P/xara",
    winlinkNative: false,
    // Open-source (MIT) VARA-compatible modem: VARA HF 500/2300/2750 and VARA FM narrow/wide
    // waveforms, VARA host protocol on 8300/8301. Its authors test it against VARA HF 4.9.0 and
    // FM 4.4.0 over audio loopback; on-air interop with VARA is not yet established, so the feed
    // keeps it under its own service code XARA (the convention its sysops use on Winlink).
    compat: (v) => {
      const s = v === "FM WIDE" ? "VARA FM WIDE" : v === "FM NARROW" ? "VARA FM" : !v || v === "2300" ? "VARA" : `VARA ${v}`;
      return { supportedModes: s, mode: OPENRMS_MODE_CODES.xara, serviceCode: "XARA" };
    },
  },
  {
    id: "data2g",
    label: "Data2G",
    // Session bandwidth cap in Hz (Data2G picks its own submode within it).
    variants: ["500", "1200", "2400"],
    defaultVariant: "2400",
    band: "any",
    homepage: "https://github.com/arodland/Data2G",
    winlinkNative: false,
    // Its own OFDM/PSK/QAM/FSK waveform (cannot talk to VARA on the air), driven through the
    // VARA host protocol on 8300/8301, so Pat dials it as VARA HF. Same convention as Mercury:
    // VARA + service code DATA2G, which is how Data2G gateways list themselves on Winlink.
    compat: (v) => ({ supportedModes: v === "500" ? "VARA 500" : "VARA", mode: OPENRMS_MODE_CODES.data2g, serviceCode: "DATA2G" }),
  },
  {
    id: "modem73",
    label: "modem73",
    variants: [],
    band: "any",
    homepage: "https://github.com/RFnexus/modem73",
    winlinkNative: false,
    compat: () => null,
  },
  {
    id: "ion-hf",
    label: "ION HF",
    variants: [],
    band: "hf",
    homepage: "https://github.com/jesseforkum/ion-hf",
    winlinkNative: false,
    compat: () => null,
  },
  {
    id: "freedata",
    label: "FreeDATA",
    variants: [],
    band: "hf",
    homepage: "https://github.com/DJ2LS/FreeDATA",
    winlinkNative: false,
    compat: () => null,
  },
  {
    id: "other",
    label: "Other",
    variants: [],
    band: "any",
    winlinkNative: false,
    compat: () => null,
  },
];

export const MODEM_IDS = MODEMS.map((m) => m.id) as [ModemId, ...ModemId[]];

export function getModem(id: string): Modem | undefined {
  return MODEMS.find((m) => m.id === id);
}

/**
 * Map a Winlink SupportedModes string (plus service code) to the real modem.
 * VARA channels listed under service code MERCURY, DATA2G or XARA are Mercury, Data2G or
 * XARA gateways: the convention those sysops use on Winlink today (they speak the VARA host
 * protocol, so Winlink clients dial them as VARA).
 */
export function parseWinlinkModes(
  supportedModes: string,
  serviceCode: string,
): { modem: ModemId; variant: string | null } {
  const s = supportedModes.trim();
  const code = serviceCode.trim().toUpperCase();
  const rest = (prefix: RegExp) => s.replace(prefix, "").trim() || null;
  if (/^VARA FM/i.test(s)) {
    const wide = /WIDE/i.test(s);
    if (code === "XARA") return { modem: "xara", variant: wide ? "FM WIDE" : "FM NARROW" };
    return { modem: "vara-fm", variant: wide ? "WIDE" : "NARROW" };
  }
  if (/^VARA/i.test(s)) {
    const bw = rest(/^VARA/i);
    if (code === "MERCURY") return { modem: "mercury", variant: null };
    if (code === "XARA") return { modem: "xara", variant: bw ?? "2300" };
    // Data2G variants are its bandwidth caps; VARA 2750 listings mean full width (2400).
    if (code === "DATA2G") return { modem: "data2g", variant: bw === "500" ? "500" : "2400" };
    return { modem: "vara-hf", variant: bw ?? "2300" };
  }
  if (/^Robust Packet/i.test(s)) return { modem: "robust-packet", variant: null };
  if (/^Packet/i.test(s)) return { modem: "packet", variant: rest(/^Packet/i) };
  if (/^Pactor/i.test(s)) return { modem: "pactor", variant: rest(/^Pactor/i) };
  if (/^ARDOP/i.test(s)) return { modem: "ardop", variant: rest(/^ARDOP/i) };
  return { modem: "other", variant: s || null };
}

/** Band name for a frequency in Hz (amateur allocations, rough edges). */
export function bandOf(hz: number): string | null {
  const mhz = hz / 1e6;
  const bands: [string, number, number][] = [
    ["160m", 1.8, 2.0],
    ["80m", 3.5, 4.0],
    ["60m", 5.25, 5.45],
    ["40m", 7.0, 7.3],
    ["30m", 10.1, 10.15],
    ["20m", 14.0, 14.35],
    ["17m", 18.068, 18.168],
    ["15m", 21.0, 21.45],
    ["12m", 24.89, 24.99],
    ["10m", 28.0, 29.7],
    ["6m", 50, 54],
    ["2m", 144, 148],
    ["1.25m", 219, 225],
    ["70cm", 420, 450],
  ];
  for (const [name, lo, hi] of bands) if (mhz >= lo && mhz <= hi) return name;
  return null;
}
