import { NextResponse } from "next/server";
import { z } from "zod";
import { getApiKeyMetadata, validateApiKey } from "@/lib/localDb";
import { getRequestLimitStatus, getSuccessfulRequestCounts } from "@/lib/portal/requestLimits";

export const runtime = "nodejs";

const checkRequestSchema = z.object({ apiKey: z.string().trim().min(1) });

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const validation = checkRequestSchema.safeParse(rawBody);
  if (!validation.success) return jsonError("apiKey is required", 400);
  const { apiKey } = validation.data;

  if (!(await validateApiKey(apiKey))) {
    return jsonError("API Key tidak valid atau tidak aktif", 401);
  }

  const meta = await getApiKeyMetadata(apiKey);
  if (!meta?.id) return jsonError("API Key tidak ditemukan", 404);

  const counts = getSuccessfulRequestCounts(meta.id);
  const primaryLimit = getRequestLimitStatus(meta.id);

  const maxDay = typeof meta.maxRequestsPerDay === "number" ? meta.maxRequestsPerDay : null;
  const maxMinute =
    typeof meta.maxRequestsPerMinute === "number" ? meta.maxRequestsPerMinute : null;

  return NextResponse.json({
    keyId: meta.id,
    keyPrefix: meta.id === "env-key" ? "env-key" : meta.keyHash ? meta.id.slice(0, 8) : meta.id,
    name: meta.name || "API Key",
    keyType: meta.id === "env-key" ? "environment" : "api_key",
    counts,
    countsNote: "Hanya request sukses yang tercatat di usage_history yang dihitung.",
    limits: {
      ...primaryLimit,
      maxRequestsPerDay: maxDay,
      remainingToday:
        maxDay !== null ? Math.max(0, maxDay - counts.todayRequests) : null,
      maxRequestsPerMinute: maxMinute,
      remainingThisHour:
        maxMinute !== null ? Math.max(0, maxMinute - counts.minuteRequests) : null,
    },
  });
}
