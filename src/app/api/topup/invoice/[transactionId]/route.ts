import { NextResponse } from "next/server";
import { getApiKeyMetadata, validateApiKey } from "@/lib/localDb";
import { getTopupTransaction } from "@/lib/portal/requestLimits";

export const runtime = "nodejs";

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>\"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '\"': "&quot;",
  })[c] || c);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ transactionId: string }> }
) {
  const { transactionId } = await params;
  const apiKey = new URL(request.url).searchParams.get("apiKey")?.trim() || "";
  if (!apiKey || !(await validateApiKey(apiKey))) {
    return NextResponse.json({ error: "API Key tidak valid atau tidak aktif" }, { status: 401 });
  }

  const meta = await getApiKeyMetadata(apiKey);
  const tx = getTopupTransaction(transactionId);
  if (!tx || !meta?.id || tx.apiKeyId !== meta.id) {
    return NextResponse.json({ error: "Invoice tidak ditemukan" }, { status: 404 });
  }

  const html = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><title>Invoice ${esc(tx.id)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#0f172a}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #e5e7eb}.total{font-size:20px;font-weight:700}</style>
</head><body>
<h1>Invoice Topup Request Limit</h1>
<table>
<tr><td>ID Transaksi</td><td>${esc(tx.id)}</td></tr>
<tr><td>API Key</td><td>${esc(tx.apiKeyName || tx.keyPrefix || "API Key")}</td></tr>
<tr><td>Status</td><td>${esc(tx.status)}${tx.credited ? " / credited" : ""}</td></tr>
<tr><td>Paket</td><td>${tx.packages}</td></tr>
<tr><td>Request ditambahkan</td><td>${tx.requestsToAdd.toLocaleString("id-ID")}</td></tr>
<tr><td>Total</td><td class="total">Rp ${tx.totalIdr.toLocaleString("id-ID")}</td></tr>
<tr><td>Dibuat</td><td>${esc(tx.createdAt)}</td></tr>
<tr><td>Dikreditkan</td><td>${esc(tx.creditedAt || "-")}</td></tr>
</table>
<script>window.print && setTimeout(()=>window.print(), 300)</script>
</body></html>`;

  return new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
