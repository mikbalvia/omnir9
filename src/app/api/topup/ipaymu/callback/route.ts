import { NextResponse } from "next/server";
import { z } from "zod";
import { creditTopupTransaction, updateTopupTransactionStatus } from "@/lib/portal/requestLimits";
import { verifyIpaymuCallbackSignature } from "@/lib/portal/ipaymu";

export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;

const callbackPayloadSchema = z.record(z.string(), z.unknown());

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

async function readCallbackPayload(request: Request): Promise<JsonRecord> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return asRecord(await request.json());
  }
  const text = await request.text();
  const params = new URLSearchParams(text);
  const payload: JsonRecord = {};
  for (const [key, value] of params.entries()) payload[key] = value;
  return payload;
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isSuccess(payload: JsonRecord): boolean {
  const statusCode = Number(
    payload.status_code ?? payload.transaction_status_code ?? payload.Status ?? payload.status
  );
  const statusText = text(payload.status || payload.StatusDesc || payload.status_desc).toLowerCase();
  return [1, 6, 7].includes(statusCode) || statusText === "berhasil" || statusText === "success";
}

function isExpired(payload: JsonRecord): boolean {
  const statusCode = Number(payload.status_code ?? payload.transaction_status_code);
  const statusText = text(payload.status || payload.StatusDesc || payload.status_desc).toLowerCase();
  return statusCode === -2 || statusText.includes("expired") || statusText.includes("kedaluwarsa");
}

export async function POST(request: Request) {
  let payload: JsonRecord;
  try {
    payload = await readCallbackPayload(request);
  } catch {
    return NextResponse.json({ status: "error", message: "Invalid callback payload" }, { status: 400 });
  }

  const validation = callbackPayloadSchema.safeParse(payload);
  if (!validation.success) {
    return NextResponse.json({ status: "error", message: "Invalid callback payload" }, { status: 400 });
  }
  payload = validation.data;

  if (!verifyIpaymuCallbackSignature(payload)) {
    return NextResponse.json({ status: "error", message: "Invalid signature" }, { status: 400 });
  }

  const referenceId = text(payload.reference_id || payload.referenceId || payload.ReferenceId);
  if (!referenceId) {
    return NextResponse.json({ status: "error", message: "Missing reference_id" }, { status: 400 });
  }

  if (isSuccess(payload)) {
    const tx = creditTopupTransaction(referenceId);
    if (!tx) return NextResponse.json({ status: "error", message: "Transaction not found" }, { status: 404 });
    return NextResponse.json({ status: "success" });
  }

  if (isExpired(payload)) {
    updateTopupTransactionStatus(referenceId, "expired");
  }

  return NextResponse.json({ status: "ok" });
}
