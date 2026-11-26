import { z } from "zod";
import { MODEM_IDS, getModem } from "../modes.js";
import { isValidGrid } from "../lib/callsign.js";

const grid = z.string().trim().refine(isValidGrid, "invalid Maidenhead locator").transform((g) => g.slice(0, 4).toUpperCase() + g.slice(4).toLowerCase());
const text = (max: number) => z.string().trim().max(max);
/** A Winlink service code: A-Z and 0-9, 1 to 16 characters (stored uppercase). */
export const serviceCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,16}$/, "service codes are 1-16 letters or digits");

export const channelInput = z
  .object({
    frequencyHz: z.number().int().positive().max(1_300_000_000).optional(),
    frequencyKhz: z.number().positive().max(1_300_000).optional(),
    modem: z.enum(MODEM_IDS),
    variant: text(32).nullish(),
    modemVersion: text(64).nullish(),
    serviceCode: serviceCodeSchema.default("PUBLIC"),
    // Other codes the same channel is listed under. New codes start unlisted (not enumerated, not secret).
    extraServiceCodes: z.array(serviceCodeSchema).max(8).default([]),
    operatingHours: text(64).default("00-23"),
    antenna: text(64).default(""),
    radioRange: text(32).default(""),
    gridsquare: grid.nullish(),
    baud: text(16).default("0"),
    notes: text(500).default(""),
    compatSupportedModes: text(64).nullish(),
  })
  .refine((c) => c.frequencyHz || c.frequencyKhz, "frequencyHz or frequencyKhz is required")
  .refine((c) => {
    const m = getModem(c.modem);
    return !c.variant || !m || m.variants.length === 0 || m.variants.includes(c.variant);
  }, "variant is not valid for this modem")
  .transform((c) => ({
    ...c,
    frequencyHz: c.frequencyHz ?? Math.round(c.frequencyKhz! * 1000),
    extraServiceCodes: [...new Set(c.extraServiceCodes)].filter((x) => x !== c.serviceCode),
  }));

export const emcommInput = z
  .object({
    backupPower: z.array(z.enum(["battery", "solar", "generator", "wind", "grid-only"])).default([]),
    runtimeHours: z.number().min(0).max(10_000).nullish(),
    offGrid: z.boolean().default(false),
    lastTested: z.iso.date().nullish(),
    servedAgencies: text(300).default(""),
    aresRaces: z.boolean().default(false),
    activationContact: text(200).default(""), // public: sysop chooses what to put here
  })
  .partial();

export const gatewayInput = z
  .object({
    callsign: z.string().trim().toUpperCase(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    gridsquare: grid,
    locationPrecision: z.enum(["exact", "grid6", "grid4"]).default("exact"),
    comments: text(500).default(""),
    software: text(100).nullish(),
    winlinkListed: z.boolean().default(false),
    emcomm: emcommInput.default({}),
    channels: z.array(channelInput).min(1).max(64),
  })
  .refine((g) => (g.latitude == null) === (g.longitude == null), "latitude and longitude go together");

export type GatewayInput = z.infer<typeof gatewayInput>;

/** What a sysop may add to a claimed Winlink listing. Channels and location stay Winlink's. */
export const claimDetailsInput = z.object({
  comments: text(1000).default(""),
  software: text(100).nullish(),
  emcomm: emcommInput.default({}),
});

export const heartbeatInput = z
  .object({
    currentFrequencyHz: z.number().int().positive().nullish(),
    currentModem: z.enum(MODEM_IDS).nullish(),
    busy: z.boolean().optional(),
    software: text(100).nullish(),
  })
  .default({});
