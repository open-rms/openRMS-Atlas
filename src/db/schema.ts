// openRMS Atlas schema (Drizzle). Source of truth for openRMS's own tables.
//
// Workflow: edit this file → `pnpm db:generate` (writes a versioned SQL migration into
// ./drizzle, review and commit it) → migrations apply at startup or with `pnpm migrate`.
// Identity (accounts, sessions, clubs, roles) lives in openRMS-Accounts. Rows here store the
// Accounts `sub` / club id as plain text, plus a local cache of account facts (below).
import { sql } from "drizzle-orm";
import {
  bigint, bigserial, boolean, check, doublePrecision, foreignKey, index, integer, jsonb, pgTable, primaryKey, real, text,
  timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** A gateway (RMS): listed by its owner (source openrms) or imported from Winlink. */
export const gateway = pgTable(
  "gateway",
  {
    id: uuid().defaultRandom().primaryKey(),
    source: text().notNull(),
    callsign: text().notNull(), // as dialled, with SSID
    baseCallsign: text("base_callsign").notNull(),
    latitude: doublePrecision(),
    longitude: doublePrecision(),
    gridsquare: text(),
    locationPrecision: text("location_precision").default("exact").notNull(),
    comments: text().default("").notNull(),
    software: text(),
    winlinkListed: boolean("winlink_listed").default(false).notNull(),
    emcomm: jsonb().default({}).notNull(),
    hidden: boolean().default(false).notNull(),
    hiddenReason: text("hidden_reason"),
    lastHeartbeatAt: ts("last_heartbeat_at"),
    confirmedAt: ts("confirmed_at"),
    winlinkLastStatus: ts("winlink_last_status"),
    removedAt: ts("removed_at"),
    live: jsonb().default({}).notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
    // Claims: details a sysop adds to a Winlink listing. The import never writes these.
    ownerComments: text("owner_comments").default("").notNull(),
    claimedAt: ts("claimed_at"),
    // Accounts ids (identity.md): the account `sub` and club id. No FK: accounts live in Accounts.
    ownerSub: text("owner_sub"),
    ownerClubId: text("owner_club_id"),
  },
  (t) => [
    index("gateway_base_callsign").on(t.baseCallsign),
    index("gateway_owner_sub").on(t.ownerSub),
    index("gateway_owner_club").on(t.ownerClubId),
    unique("gateway_source_callsign_key").on(t.source, t.callsign),
    check("gateway_source_check", sql`source = ANY (ARRAY['openrms'::text, 'winlink'::text])`),
    check("gateway_location_precision_check", sql`location_precision = ANY (ARRAY['exact'::text, 'grid6'::text, 'grid4'::text])`),
  ],
);

export const channel = pgTable(
  "channel",
  {
    id: uuid().defaultRandom().primaryKey(),
    gatewayId: uuid("gateway_id").notNull(),
    frequencyHz: bigint("frequency_hz", { mode: "number" }).notNull(), // centre frequency
    modem: text().notNull(), // registry id, src/modes.ts
    variant: text(),
    modemVersion: text("modem_version"),
    serviceCode: text("service_code").default("PUBLIC").notNull(),
    // More service codes the same channel is listed under (e.g. PUBLIC plus a group code).
    extraServiceCodes: text("extra_service_codes").array().default(sql`'{}'::text[]`).notNull(),
    operatingHours: text("operating_hours").default("00-23").notNull(),
    antenna: text().default("").notNull(),
    radioRange: text("radio_range").default("").notNull(),
    gridsquare: text(),
    baud: text().default("0").notNull(),
    notes: text().default("").notNull(),
    winlinkSupportedModes: text("winlink_supported_modes"),
    winlinkMode: integer("winlink_mode"),
    compatSupportedModes: text("compat_supported_modes"),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("channel_gateway").on(t.gatewayId),
    index("channel_modem").on(t.modem),
    foreignKey({ columns: [t.gatewayId], foreignColumns: [gateway.id], name: "channel_gateway_id_fkey" }).onDelete("cascade"),
    check("channel_frequency_hz_check", sql`frequency_hz > 0`),
  ],
);

// Service codes and who may see them. "public" codes are listed (filter chips, stats, dumps).
// "unlisted" codes are never enumerated and match only an exact ?serviceCode= request.
// Unlisted means not listed, not secret. A code nobody has seen yet starts unlisted; staff promote it.
export const serviceCode = pgTable(
  "service_code",
  {
    code: text().primaryKey(),
    visibility: text().default("unlisted").notNull(),
    description: text().default("").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by"),
  },
  () => [
    check("service_code_code_check", sql`code ~ '^[A-Z0-9]{1,16}$'`),
    check("service_code_visibility_check", sql`visibility IN ('public', 'unlisted')`),
  ],
);

export const importRun = pgTable("import_run", {
  id: bigserial({ mode: "number" }).primaryKey(),
  source: text().notNull(),
  startedAt: ts("started_at").defaultNow().notNull(),
  finishedAt: ts("finished_at"),
  ok: boolean(),
  gateways: integer(),
  channels: integer(),
  message: text(),
});

export const abuseReport = pgTable(
  "abuse_report",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    gatewayId: uuid("gateway_id"),
    reporterSub: text("reporter_sub"),
    reason: text().notNull(),
    resolvedAt: ts("resolved_at"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.gatewayId], foreignColumns: [gateway.id], name: "abuse_report_gateway_id_fkey" }).onDelete("cascade"),
  ],
);

/** Staff actions (role changes, verifications, hides, imports, settings). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    actorSub: text("actor_sub"),
    action: text().notNull(),
    target: text(),
    detail: text(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("audit_log_actor").on(t.actorSub)],
);

/** openRMS-Watch receivers (openRMS-Spec/watch/feed.md). */
export const watcher = pgTable(
  "watcher",
  {
    id: uuid().defaultRandom().primaryKey(),
    ownerSub: text("owner_sub").notNull(), // Accounts `sub`
    name: text().notNull(),
    gridsquare: text(),
    locationPrecision: text("location_precision").default("grid4").notNull(),
    public: boolean().default(true).notNull(),
    apiKeyId: text("api_key_id"),
    disabled: boolean().default(false).notNull(),
    disabledReason: text("disabled_reason"),
    lastSeenAt: ts("last_seen_at"),
    lastStatus: jsonb("last_status").default({}).notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("watcher_api_key").on(t.apiKeyId),
    index("watcher_owner").on(t.ownerSub),
    check("watcher_location_precision_check", sql`location_precision = ANY (ARRAY['grid4'::text, 'grid6'::text, 'hidden'::text])`),
  ],
);

/** Raw watcher uploads. Client callsigns are stored; visibility is decided at read time. */
export const watchEvent = pgTable(
  "watch_event",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    watcherId: uuid("watcher_id").notNull(),
    eventId: text("event_id").notNull(),
    type: text().notNull(),
    ts: ts("ts").notNull(),
    tsEnd: ts("ts_end"),
    receivedAt: ts("received_at").defaultNow().notNull(),
    modem: text(),
    dialHz: bigint("dial_hz", { mode: "number" }),
    kind: text(),
    fromCall: text("from_call"),
    toCrc: text("to_crc"),
    callerCrc: text("caller_crc"),
    calledCrc: text("called_crc"),
    snrDb: real("snr_db"),
    payload: jsonb().notNull(),
    accepted: boolean(),
    hint: jsonb(),
  },
  (t) => [
    index("watch_event_crc").on(t.calledCrc, t.toCrc).where(sql`(type = 'frame'::text)`),
    index("watch_event_ts").on(t.ts.desc().nullsFirst()),
    foreignKey({ columns: [t.watcherId], foreignColumns: [watcher.id], name: "watch_event_watcher_id_fkey" }).onDelete("cascade"),
    unique("watch_event_watcher_id_event_id_key").on(t.watcherId, t.eventId),
    check("watch_event_type_check", sql`type = ANY (ARRAY['frame'::text, 'attempt'::text, 'coverage'::text, 'status'::text])`),
  ],
);

export const siteSetting = pgTable(
  "site_setting",
  {
    key: text().primaryKey(),
    value: jsonb().notNull(),
    updatedBySub: text("updated_by_sub"),
    updatedAt: ts("updated_at").defaultNow().notNull(),
  },
);

export const callsignOptout = pgTable(
  "callsign_optout",
  {
    callsign: text().primaryKey(),
    reason: text(),
    createdBySub: text("created_by_sub"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
);

// ── Identity from openRMS-Accounts (identity.md §7 "Local account cache") ──────────────
// Facts about accounts other than the caller's, used inside queries (gateway dedupe, club
// verification, sightings "confirmed", contributors) and checked on writes (bans, club
// membership). Fed by Accounts webhooks and refreshed from each caller's own token.

export const account = pgTable("account_cache", {
  sub: text().primaryKey(),
  callsign: text().notNull(),
  callsignVerified: boolean("callsign_verified").default(false).notNull(),
  callsignVerifiedMethod: text("callsign_verified_method"),
  name: text(),
  role: text().default("user").notNull(),
  banned: boolean().default(false).notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("account_cache_callsign").on(t.callsign)]);

export const accountClub = pgTable("account_club", {
  id: text().primaryKey(),
  callsign: text().notNull(),
  name: text().notNull(),
  verified: boolean().default(false).notNull(),
  updatedAt: ts("updated_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("account_club_callsign").on(t.callsign)]);

export const accountClubMember = pgTable("account_club_member", {
  clubId: text("club_id").notNull(),
  sub: text().notNull(),
  role: text().notNull(), // owner | admin | member
  updatedAt: ts("updated_at").defaultNow().notNull(),
}, (t) => [
  primaryKey({ columns: [t.clubId, t.sub] }),
  index("account_club_member_sub").on(t.sub),
  foreignKey({ columns: [t.clubId], foreignColumns: [accountClub.id], name: "account_club_member_club_fkey" }).onDelete("cascade"),
]);

/** Webhook deliveries already applied (identity.md §7: handle each event id once). */
export const accountEvent = pgTable("account_event", {
  id: text().primaryKey(),
  type: text().notNull(),
  receivedAt: ts("received_at").defaultNow().notNull(),
});

/**
 * Service-owned API keys (identity.md §5). The kind is fixed at creation. Hash is
 * base64url(sha256(key)) unpadded, the same as Better Auth's, so earlier keys imported as-is.
 */
export const apiKey = pgTable("api_key", {
  id: text().primaryKey(),
  kind: text().notNull(), // gateway | watcher
  name: text(),
  prefix: text().notNull(),
  start: text(),
  hash: text().notNull(),
  ownerSub: text("owner_sub").notNull(),
  watcherId: uuid("watcher_id"),
  gatewayIds: jsonb("gateway_ids"), // gateway keys limited to these gateways (null = all of the owner's)
  rateWindowStart: ts("rate_window_start"),
  rateCount: integer("rate_count").default(0).notNull(),
  lastUsedAt: ts("last_used_at"),
  expiresAt: ts("expires_at"),
  revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("api_key_hash").on(t.hash),
  index("api_key_owner").on(t.ownerSub),
  check("api_key_kind_check", sql`kind = ANY (ARRAY['gateway'::text, 'watcher'::text])`),
]);
