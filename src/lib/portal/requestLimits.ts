import { getDbInstance } from "@/lib/db/core";
import { isIpaymuConfigured } from "@/lib/portal/ipaymu";

type RunResult = { changes?: number };
type StatementLike = {
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
  run: (...args: unknown[]) => RunResult;
};
type DbLike = {
  exec: (sql: string) => void;
  prepare: (sql: string) => StatementLike;
};

type Row = Record<string, unknown>;

export type PortalProduct = {
  id: string;
  title: string;
  description: string;
  priceIdr: number;
  requestsPerPackage: number;
  maxPackages: number;
};

export type RequestCounts = {
  totalRequests: number;
  todayRequests: number;
  hourRequests: number;
  minuteRequests: number;
  lastRequestAt: string | null;
};

export type RequestLimitStatus = {
  primaryMaxLimit: number | null;
  primaryUsed: number;
  primaryRemaining: number | null;
};

export type TopupTransaction = {
  id: string;
  apiKeyId: string;
  apiKeyName: string | null;
  keyPrefix: string | null;
  packages: number;
  requestsToAdd: number;
  totalIdr: number;
  status: string;
  credited: boolean;
  creditedAt: string | null;
  buyerPhone: string | null;
  buyerEmail: string | null;
  providerRef: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

let schemaEnsured = false;

function db(): DbLike {
  return getDbInstance() as unknown as DbLike;
}

export function ensurePortalTables(): void {
  if (schemaEnsured) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS api_key_request_limits (
      api_key_id TEXT PRIMARY KEY,
      max_requests_total INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS portal_topup_transactions (
      id TEXT PRIMARY KEY,
      api_key_id TEXT NOT NULL,
      api_key_name TEXT,
      key_prefix TEXT,
      packages INTEGER NOT NULL,
      requests_to_add INTEGER NOT NULL,
      total_idr INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      credited INTEGER NOT NULL DEFAULT 0,
      credited_at TEXT,
      buyer_phone TEXT,
      buyer_email TEXT,
      provider_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_portal_topup_api_key_id ON portal_topup_transactions(api_key_id);
    CREATE INDEX IF NOT EXISTS idx_portal_topup_status ON portal_topup_transactions(status);
    CREATE INDEX IF NOT EXISTS idx_portal_topup_created_at ON portal_topup_transactions(created_at);
  `);
  schemaEnsured = true;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function positiveEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function getPortalProduct(): PortalProduct {
  const requestsPerPackage = positiveEnvInt("OMNIROUTE_TOPUP_REQUESTS_PER_PACKAGE", 100);
  const priceIdr = positiveEnvInt("OMNIROUTE_TOPUP_PRICE_IDR", 10_000);
  return {
    id: process.env.OMNIROUTE_TOPUP_PRODUCT_ID?.trim() || "request-limit",
    title: process.env.OMNIROUTE_TOPUP_TITLE?.trim() || "Tambah Limit Request",
    description:
      process.env.OMNIROUTE_TOPUP_DESCRIPTION?.trim() ||
      `Tambahan ${requestsPerPackage.toLocaleString("id-ID")} request untuk API Key Anda.`,
    priceIdr,
    requestsPerPackage,
    maxPackages: positiveEnvInt("OMNIROUTE_TOPUP_MAX_PACKAGES", 10),
  };
}

export function isTopupEnabled(): boolean {
  return envFlag("OMNIROUTE_TOPUP_ENABLED", false);
}

export function isTopupMaintenance(): boolean {
  if (envFlag("OMNIROUTE_TOPUP_MAINTENANCE", false) || !isTopupEnabled()) return true;
  if (isTopupAutoCreditEnabled() || isIpaymuConfigured()) return false;
  return !getPaymentUrl() && !getPaymentQrString();
}

export function isTopupAutoCreditEnabled(): boolean {
  return envFlag("OMNIROUTE_TOPUP_AUTO_CREDIT", false);
}

export function getPaymentUrl(): string | null {
  return process.env.OMNIROUTE_TOPUP_PAYMENT_URL?.trim() || null;
}

export function getPaymentQrString(): string | null {
  return process.env.OMNIROUTE_TOPUP_QR_STRING?.trim() || null;
}

function dayStartIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function hourStartIso(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

function minuteStartIso(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return d.toISOString();
}

export function getSuccessfulRequestCounts(apiKeyId: string): RequestCounts {
  const database = db();
  // Lifetime request accounting is weighted: successful GPT/Claude requests cost 2,
  // other successful requests cost 1. We intentionally key off both provider and model
  // because combo usage rows usually persist the selected leaf model rather than only the
  // requested combo name.
  const weightExpr = `CASE
    WHEN lower(COALESCE(model, '') || ' ' || COALESCE(provider, '')) LIKE '%gpt%'
      OR lower(COALESCE(model, '') || ' ' || COALESCE(provider, '')) LIKE '%claude%'
    THEN 2 ELSE 1 END`;
  const row = database
    .prepare(
      `SELECT
        COALESCE(SUM(${weightExpr}), 0) AS totalRequests,
        COALESCE(SUM(CASE WHEN timestamp >= ? THEN ${weightExpr} ELSE 0 END), 0) AS todayRequests,
        COALESCE(SUM(CASE WHEN timestamp >= ? THEN ${weightExpr} ELSE 0 END), 0) AS hourRequests,
        COALESCE(SUM(CASE WHEN timestamp >= ? THEN ${weightExpr} ELSE 0 END), 0) AS minuteRequests,
        MAX(timestamp) AS lastRequestAt
       FROM usage_history
       WHERE api_key_id = ? AND COALESCE(success, 1) = 1 AND CAST(status AS INTEGER) = 200`
    )
    .get(dayStartIso(), hourStartIso(), minuteStartIso(), apiKeyId) as Row | undefined;

  return {
    totalRequests: toInt(row?.totalRequests),
    todayRequests: toInt(row?.todayRequests),
    hourRequests: toInt(row?.hourRequests),
    minuteRequests: toInt(row?.minuteRequests),
    lastRequestAt: typeof row?.lastRequestAt === "string" ? row.lastRequestAt : null,
  };
}

export function getRequestLimitStatus(apiKeyId: string): RequestLimitStatus {
  ensurePortalTables();
  const row = db()
    .prepare("SELECT max_requests_total FROM api_key_request_limits WHERE api_key_id = ?")
    .get(apiKeyId) as Row | undefined;
  const max = toInt(row?.max_requests_total, 0) || getLegacyLifetimeLimit(apiKeyId);
  const counts = getSuccessfulRequestCounts(apiKeyId);
  if (!max || max <= 0) {
    return { primaryMaxLimit: null, primaryUsed: counts.totalRequests, primaryRemaining: null };
  }
  return {
    primaryMaxLimit: max,
    primaryUsed: counts.totalRequests,
    primaryRemaining: Math.max(0, max - counts.totalRequests),
  };
}

export function isRequestLimitExceeded(apiKeyId: string): boolean {
  const status = getRequestLimitStatus(apiKeyId);
  return status.primaryMaxLimit !== null && (status.primaryRemaining ?? 0) <= 0;
}

export function addRequestLimit(apiKeyId: string, requestsToAdd: number): RequestLimitStatus {
  ensurePortalTables();
  const add = Math.max(0, Math.trunc(Number(requestsToAdd) || 0));
  if (add <= 0) throw new Error("requestsToAdd must be greater than zero");

  const database = db();
  const current = database
    .prepare("SELECT max_requests_total FROM api_key_request_limits WHERE api_key_id = ?")
    .get(apiKeyId) as Row | undefined;
  const now = nowIso();
  const currentMax = toInt(current?.max_requests_total, 0) || getLegacyLifetimeLimit(apiKeyId) || 0;
  const used = getSuccessfulRequestCounts(apiKeyId).totalRequests;
  // "Topup +N request" means add N usable remaining requests. For existing
  // keys that already have usage history but no lifetime quota row yet, start
  // from the larger of persisted max and current usage so the new package is
  // not instantly exhausted.
  const nextMax = Math.max(currentMax, used) + add;

  if (current) {
    database
      .prepare(
        "UPDATE api_key_request_limits SET max_requests_total = ?, updated_at = ? WHERE api_key_id = ?"
      )
      .run(nextMax, now, apiKeyId);
  } else {
    database
      .prepare(
        "INSERT INTO api_key_request_limits (api_key_id, max_requests_total, created_at, updated_at) VALUES (?, ?, ?, ?)"
      )
      .run(apiKeyId, nextMax, now, now);
  }

  return getRequestLimitStatus(apiKeyId);
}

function getLegacyLifetimeLimit(apiKeyId: string): number | null {
  const row = db().prepare("SELECT rate_limits FROM api_keys WHERE id = ?").get(apiKeyId) as
    | Row
    | undefined;
  const raw = typeof row?.rate_limits === "string" ? row.rate_limits : "";
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const candidates = parsed
      .map((rule) => asRateLimitRule(rule))
      .filter((rule): rule is { limit: number; window: number } => Boolean(rule))
      // Existing portal data stored the lifetime request cap as a 1-year window.
      // Display/enforce it as true lifetime quota (no reset) using usage_history.
      .filter((rule) => rule.window >= 31_536_000)
      .map((rule) => rule.limit);
    return candidates.length > 0 ? Math.max(...candidates) : null;
  } catch {
    return null;
  }
}

function asRateLimitRule(value: unknown): { limit: number; window: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Row;
  const limit = Number(record.limit);
  const window = Number(record.window);
  if (!Number.isFinite(limit) || !Number.isFinite(window) || limit <= 0 || window <= 0) return null;
  return { limit: Math.trunc(limit), window: Math.trunc(window) };
}

function mapTopup(row: Row | undefined): TopupTransaction | null {
  if (!row) return null;
  return {
    id: String(row.id || ""),
    apiKeyId: String(row.api_key_id || ""),
    apiKeyName: typeof row.api_key_name === "string" ? row.api_key_name : null,
    keyPrefix: typeof row.key_prefix === "string" ? row.key_prefix : null,
    packages: toInt(row.packages),
    requestsToAdd: toInt(row.requests_to_add),
    totalIdr: toInt(row.total_idr),
    status: String(row.status || "pending"),
    credited: toInt(row.credited) === 1,
    creditedAt: typeof row.credited_at === "string" ? row.credited_at : null,
    buyerPhone: typeof row.buyer_phone === "string" ? row.buyer_phone : null,
    buyerEmail: typeof row.buyer_email === "string" ? row.buyer_email : null,
    providerRef: typeof row.provider_ref === "string" ? row.provider_ref : null,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
  };
}

export function generateTopupTransactionId(): string {
  return `topup_${globalThis.crypto.randomUUID()}`;
}

export function createTopupTransaction(input: {
  id?: string;
  apiKeyId: string;
  apiKeyName?: string | null;
  keyPrefix?: string | null;
  packages: number;
  requestsToAdd: number;
  totalIdr: number;
  buyerPhone?: string | null;
  buyerEmail?: string | null;
  providerRef?: string | null;
  expiresAt?: string | null;
  autoCredit?: boolean;
}): TopupTransaction {
  ensurePortalTables();
  const id = input.id || generateTopupTransactionId();
  const now = nowIso();
  const expiresAt = input.expiresAt || new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const credited = input.autoCredit ? 1 : 0;
  const status = input.autoCredit ? "success" : "pending";
  const creditedAt = input.autoCredit ? now : null;

  db()
    .prepare(
      `INSERT INTO portal_topup_transactions
       (id, api_key_id, api_key_name, key_prefix, packages, requests_to_add, total_idr, status,
        credited, credited_at, buyer_phone, buyer_email, provider_ref, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.apiKeyId,
      input.apiKeyName || null,
      input.keyPrefix || null,
      input.packages,
      input.requestsToAdd,
      input.totalIdr,
      status,
      credited,
      creditedAt,
      input.buyerPhone || null,
      input.buyerEmail || null,
      input.providerRef || null,
      now,
      now,
      expiresAt
    );

  if (input.autoCredit) {
    addRequestLimit(input.apiKeyId, input.requestsToAdd);
  }

  const tx = getTopupTransaction(id);
  if (!tx) throw new Error("Failed to create topup transaction");
  return tx;
}

export function getTopupTransaction(id: string): TopupTransaction | null {
  ensurePortalTables();
  const row = db()
    .prepare("SELECT * FROM portal_topup_transactions WHERE id = ?")
    .get(id) as Row | undefined;
  return mapTopup(row);
}

export function updateTopupTransactionStatus(
  id: string,
  status: "pending" | "success" | "failed" | "expired",
  providerRef?: string | null,
  expiresAt?: string | null
): TopupTransaction | null {
  ensurePortalTables();
  const now = nowIso();
  db()
    .prepare(
      `UPDATE portal_topup_transactions
       SET status = ?, provider_ref = COALESCE(?, provider_ref), expires_at = COALESCE(?, expires_at), updated_at = ?
       WHERE id = ?`
    )
    .run(status, providerRef || null, expiresAt || null, now, id);
  return getTopupTransaction(id);
}

export function creditTopupTransaction(id: string): TopupTransaction | null {
  ensurePortalTables();
  const tx = getTopupTransaction(id);
  if (!tx) return null;
  if (!tx.credited) {
    addRequestLimit(tx.apiKeyId, tx.requestsToAdd);
    const now = nowIso();
    db()
      .prepare(
        "UPDATE portal_topup_transactions SET status = 'success', credited = 1, credited_at = ?, updated_at = ? WHERE id = ?"
      )
      .run(now, now, id);
  }
  return getTopupTransaction(id);
}
