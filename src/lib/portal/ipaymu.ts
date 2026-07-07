import { createHmac, createHash } from "crypto";

type JsonRecord = Record<string, unknown>;

export type IpaymuConfig = {
  apiKey: string;
  va: string;
  baseUrl: string;
  account: string;
};

export type IpaymuPaymentResult = {
  transactionId: string | null;
  sessionId: string | null;
  referenceId: string | null;
  qrString: string | null;
  qrImage: string | null;
  qrTemplate: string | null;
  paymentNo: string | null;
  payUrl: string | null;
  expiredAt: string | null;
  raw: unknown;
};

export type IpaymuTransactionStatus = {
  success: boolean;
  pending: boolean;
  expired: boolean;
  failed: boolean;
  status: string;
  message: string | null;
  raw: unknown;
};

function trimEnv(name: string): string {
  return process.env[name]?.trim() || "";
}

export function getIpaymuConfig(): IpaymuConfig | null {
  const apiKey = trimEnv("IPAYMU_API_KEY") || trimEnv("OMNIROUTE_IPAYMU_API_KEY");
  const va = trimEnv("IPAYMU_VA") || trimEnv("OMNIROUTE_IPAYMU_VA");
  if (!apiKey || !va) return null;

  const sandbox = ["1", "true", "yes", "on"].includes(
    (trimEnv("IPAYMU_SANDBOX") || trimEnv("OMNIROUTE_IPAYMU_SANDBOX")).toLowerCase()
  );
  const baseUrl =
    trimEnv("IPAYMU_BASE_URL") ||
    trimEnv("OMNIROUTE_IPAYMU_BASE_URL") ||
    (sandbox ? "https://sandbox.ipaymu.com" : "https://my.ipaymu.com");

  return {
    apiKey,
    va,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    account: trimEnv("IPAYMU_ACCOUNT") || trimEnv("OMNIROUTE_IPAYMU_ACCOUNT") || va,
  };
}

export function isIpaymuConfigured(): boolean {
  return getIpaymuConfig() !== null;
}

function compactPayload(payload: JsonRecord): JsonRecord {
  const compact: JsonRecord = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.length === 0) continue;
    compact[key] = value;
  }
  return compact;
}

function signature(method: string, payload: JsonRecord, config: IpaymuConfig): string {
  const reqJson = JSON.stringify(compactPayload(payload));
  const bodyHash = createHash("sha256").update(reqJson).digest("hex");
  const stringToSign = `${method.toUpperCase()}:${config.va}:${bodyHash}:${config.apiKey}`;
  return createHmac("sha256", config.apiKey).update(stringToSign).digest("hex");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "").slice(0, 14);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function str(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function formBody(payload: JsonRecord): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(compactPayload(payload))) {
    if (Array.isArray(value)) {
      for (const item of value) form.append(`${key}[]`, String(item));
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}

async function ipaymuPost(path: string, payload: JsonRecord): Promise<unknown> {
  const config = getIpaymuConfig();
  if (!config) throw new Error("iPaymu credentials are not configured");

  const cleanPayload = compactPayload(payload);
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      va: config.va,
      signature: signature("POST", cleanPayload, config),
      timestamp: timestamp(),
      Accept: "application/json",
    },
    body: formBody(cleanPayload),
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }

  const record = asRecord(body);
  const status = Number(record.Status ?? record.status ?? response.status);
  if (!response.ok || (Number.isFinite(status) && status >= 400)) {
    const message = str(record.Message) || str(record.message) || `iPaymu request failed (${response.status})`;
    throw new Error(message);
  }

  return body;
}

export function buildIpaymuNotifyUrl(requestUrl: string): string | null {
  const explicit = trimEnv("OMNIROUTE_IPAYMU_NOTIFY_URL") || trimEnv("IPAYMU_NOTIFY_URL");
  if (explicit) return explicit;

  const publicBase = trimEnv("OMNIROUTE_PUBLIC_BASE_URL") || trimEnv("NEXT_PUBLIC_BASE_URL");
  if (publicBase) return `${publicBase.replace(/\/+$/, "")}/api/topup/ipaymu/callback`;

  try {
    const url = new URL(requestUrl);
    return `${url.origin}/api/topup/ipaymu/callback`;
  } catch {
    return null;
  }
}

export async function createIpaymuQrisPayment(input: {
  referenceId: string;
  name: string;
  phone: string;
  email: string;
  amount: number;
  comments?: string;
  notifyUrl?: string | null;
  returnUrl?: string | null;
  cancelUrl?: string | null;
}): Promise<IpaymuPaymentResult> {
  const config = getIpaymuConfig();
  if (!config) throw new Error("iPaymu credentials are not configured");

  const payload: JsonRecord = {
    name: input.name,
    phone: input.phone,
    email: input.email,
    amount: input.amount,
    notifyUrl: input.notifyUrl || undefined,
    referenceId: input.referenceId,
    paymentMethod: "qris",
    paymentChannel: "mpm",
    comments: input.comments,
    feeDirection: trimEnv("OMNIROUTE_IPAYMU_FEE_DIRECTION") || "BUYER",
    escrow: "0",
    account: config.account,
    successUrl: input.returnUrl || undefined,
    cancelUrl: input.cancelUrl || undefined,
  };

  const body = await ipaymuPost("/api/v2/payment/direct", payload);
  const data = asRecord(asRecord(body).Data ?? asRecord(body).data);
  return {
    transactionId: str(data.TransactionId ?? data.transactionId),
    sessionId: str(data.SessionId ?? data.SessionID ?? data.sessionId),
    referenceId: str(data.ReferenceId ?? data.referenceId) || input.referenceId,
    qrString: str(data.QrString ?? data.qrString ?? data.PaymentNo ?? data.paymentNo),
    qrImage: str(data.QrImage ?? data.qrImage),
    qrTemplate: str(data.QrTemplate ?? data.qrTemplate),
    paymentNo: str(data.PaymentNo ?? data.paymentNo),
    payUrl: str(data.Url ?? data.url ?? data.QrImage ?? data.qrImage),
    expiredAt: str(data.Expired ?? data.expired ?? data.ExpiredDate ?? data.expiredDate),
    raw: body,
  };
}

export async function checkIpaymuTransaction(transactionId: string): Promise<IpaymuTransactionStatus> {
  const config = getIpaymuConfig();
  if (!config) throw new Error("iPaymu credentials are not configured");

  const body = await ipaymuPost("/api/v2/transaction", {
    transactionId,
    account: config.account,
  });
  const root = asRecord(body);
  const data = asRecord(root.Data ?? root.data);
  const numericStatus = Number(data.Status ?? data.status ?? data.TransactionStatusCode);
  const paidStatus = String(data.PaidStatus ?? data.paidStatus ?? "").toLowerCase();
  const statusDesc = str(data.StatusDesc ?? data.statusDesc) || str(root.Message ?? root.message);

  const success = [1, 6, 7].includes(numericStatus) || paidStatus === "paid";
  const expired = numericStatus === -2 || /expired|kedaluwarsa/i.test(statusDesc || "");
  const failed = numericStatus < 0 && !expired;
  const pending = !success && !expired && !failed;

  return {
    success,
    pending,
    expired,
    failed,
    status: Number.isFinite(numericStatus) ? String(numericStatus) : paidStatus || "unknown",
    message: statusDesc,
    raw: body,
  };
}

export function verifyIpaymuCallbackSignature(payload: JsonRecord): boolean {
  const config = getIpaymuConfig();
  if (!config) return false;
  const received = str(payload.signature ?? payload.Signature);
  if (!received) return true; // Some dashboards send signature only in headers or not at all.

  const data: JsonRecord = {};
  for (const key of Object.keys(payload).sort()) {
    if (key.toLowerCase() === "signature") continue;
    data[key] = payload[key];
  }
  const expected = createHmac("sha256", config.va).update(JSON.stringify(data)).digest("hex");
  try {
    return received.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}
