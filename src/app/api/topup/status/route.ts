import { NextResponse } from "next/server";
import { z } from "zod";
import { getApiKeyMetadata, validateApiKey } from "@/lib/localDb";
import {
  creditTopupTransaction,
  getTopupTransaction,
  isTopupAutoCreditEnabled,
  updateTopupTransactionStatus,
} from "@/lib/portal/requestLimits";
import { checkIpaymuTransaction, isIpaymuConfigured } from "@/lib/portal/ipaymu";

export const runtime = "nodejs";

const topupStatusSchema = z.object({
  transactionId: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
});

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

  const validation = topupStatusSchema.safeParse(rawBody);
  if (!validation.success) return jsonError("transactionId and apiKey are required", 400);
  const { transactionId, apiKey } = validation.data;
  if (!(await validateApiKey(apiKey))) return jsonError("API Key tidak valid atau tidak aktif", 401);

  const meta = await getApiKeyMetadata(apiKey);
  const tx = getTopupTransaction(transactionId);
  if (!tx || !meta?.id || tx.apiKeyId !== meta.id) {
    return jsonError("Transaksi tidak ditemukan", 404);
  }

  let finalTx = tx;
  if (isTopupAutoCreditEnabled() && !tx.credited) {
    finalTx = creditTopupTransaction(tx.id) || tx;
  } else if (!tx.credited && tx.providerRef && isIpaymuConfigured()) {
    const upstream = await checkIpaymuTransaction(tx.providerRef);
    if (upstream.success) {
      finalTx = creditTopupTransaction(tx.id) || tx;
    } else if (upstream.expired) {
      finalTx = updateTopupTransactionStatus(tx.id, "expired") || tx;
    } else if (upstream.failed) {
      finalTx = updateTopupTransactionStatus(tx.id, "failed") || tx;
    }
  }

  const responseStatus = finalTx.status === "expired" ? "failed" : finalTx.status;

  return NextResponse.json({
    transactionId: finalTx.id,
    status: responseStatus,
    credited: finalTx.credited,
    requestsAdded: finalTx.credited ? finalTx.requestsToAdd : 0,
    keyLabel: finalTx.apiKeyName || finalTx.keyPrefix || "API Key",
    clientName: finalTx.apiKeyName || finalTx.keyPrefix || "API Key",
    message: finalTx.credited
      ? "Pembayaran berhasil dan limit sudah ditambahkan."
      : finalTx.status === "failed" || finalTx.status === "expired"
        ? "Pembayaran gagal atau kedaluwarsa."
        : "Menunggu pembayaran atau konfirmasi admin.",
  });
}
