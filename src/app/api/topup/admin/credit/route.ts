import { NextResponse } from "next/server";
import { z } from "zod";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeyById, getApiKeyMetadata, validateApiKey } from "@/lib/localDb";
import { addRequestLimit, creditTopupTransaction } from "@/lib/portal/requestLimits";

export const runtime = "nodejs";

const adminCreditSchema = z
  .object({
    transactionId: z.string().trim().min(1).optional(),
    apiKeyId: z.string().trim().min(1).optional(),
    apiKey: z.string().trim().min(1).optional(),
    requests: z.coerce.number().int().positive().optional(),
  })
  .refine((value) => Boolean(value.transactionId || value.requests), {
    message: "transactionId or requests is required",
  });

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const validation = adminCreditSchema.safeParse(rawBody);
  if (!validation.success) return jsonError("Invalid credit payload", 400);
  const body = validation.data;

  const transactionId = body.transactionId || "";
  if (transactionId) {
    const tx = creditTopupTransaction(transactionId);
    if (!tx) return jsonError("Transaksi tidak ditemukan", 404);
    return NextResponse.json({ success: true, transaction: tx });
  }

  const requests = body.requests || 0;

  let apiKeyId = body.apiKeyId || "";
  const rawApiKey = body.apiKey || "";
  if (!apiKeyId && rawApiKey) {
    if (!(await validateApiKey(rawApiKey))) return jsonError("API Key tidak valid", 401);
    const meta = await getApiKeyMetadata(rawApiKey);
    apiKeyId = meta?.id || "";
  }
  if (!apiKeyId) return jsonError("apiKeyId or apiKey is required", 400);

  const key = await getApiKeyById(apiKeyId);
  if (!key) return jsonError("API Key tidak ditemukan", 404);

  const status = addRequestLimit(apiKeyId, requests);
  return NextResponse.json({ success: true, apiKeyId, requestsAdded: requests, limits: status });
}
