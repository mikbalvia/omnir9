import { NextResponse } from "next/server";
import { z } from "zod";
import { getApiKeyMetadata, validateApiKey } from "@/lib/localDb";
import {
  createTopupTransaction,
  generateTopupTransactionId,
  getPaymentQrString,
  getPaymentUrl,
  getPortalProduct,
  isTopupAutoCreditEnabled,
  isTopupMaintenance,
} from "@/lib/portal/requestLimits";
import {
  buildIpaymuNotifyUrl,
  createIpaymuQrisPayment,
  isIpaymuConfigured,
} from "@/lib/portal/ipaymu";

export const runtime = "nodejs";

const createTopupSchema = z.object({
  apiKey: z.string().trim().min(1),
  packages: z.coerce.number().int().positive().optional().default(1),
  buyerPhone: z.string().trim().min(1),
  buyerEmail: z.string().trim().email().or(z.string().trim().min(3)),
});

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  if (isTopupMaintenance()) {
    return jsonError("Fitur topup sedang maintenance atau belum dikonfigurasi", 503);
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const validation = createTopupSchema.safeParse(rawBody);
  if (!validation.success) return jsonError("Data topup tidak lengkap atau tidak valid", 400);
  const body = validation.data;
  const apiKey = body.apiKey;
  if (!(await validateApiKey(apiKey))) return jsonError("API Key tidak valid atau tidak aktif", 401);

  const meta = await getApiKeyMetadata(apiKey);
  if (!meta?.id || meta.id === "env-key") {
    return jsonError("API Key ini tidak mendukung topup request limit", 400);
  }

  const product = getPortalProduct();
  const packages = Math.max(1, Math.min(product.maxPackages, body.packages));
  const buyerPhone = body.buyerPhone;
  const buyerEmail = body.buyerEmail;

  const requestsToAdd = packages * product.requestsPerPackage;
  const totalToPayIdr = packages * product.priceIdr;
  const autoCredit = isTopupAutoCreditEnabled();
  const referenceId = generateTopupTransactionId();

  if (!autoCredit && isIpaymuConfigured()) {
    const payment = await createIpaymuQrisPayment({
      referenceId,
      name: meta.name || buyerEmail.split("@")[0] || "Customer",
      phone: buyerPhone,
      email: buyerEmail,
      amount: totalToPayIdr,
      comments: `${product.title} - ${packages} paket (+${requestsToAdd} request)`,
      notifyUrl: buildIpaymuNotifyUrl(request.url),
    });

    const tx = createTopupTransaction({
      id: referenceId,
      apiKeyId: meta.id,
      apiKeyName: meta.name || null,
      keyPrefix: meta.id.slice(0, 8),
      packages,
      requestsToAdd,
      totalIdr: totalToPayIdr,
      buyerPhone,
      buyerEmail,
      providerRef: payment.transactionId,
      expiresAt: payment.expiredAt,
    });

    return NextResponse.json({
      transactionId: tx.id,
      providerTransactionId: payment.transactionId,
      status: tx.status,
      credited: tx.credited,
      keyLabel: meta.name || tx.keyPrefix || "API Key",
      requestsToAdd,
      totalToPayIdr,
      expiredAt: tx.expiresAt,
      qrString: payment.qrString,
      payLink: payment.payUrl || payment.qrImage || payment.qrTemplate,
      message: "Transaksi QRIS iPaymu dibuat dan menunggu pembayaran.",
    });
  }

  const tx = createTopupTransaction({
    id: referenceId,
    apiKeyId: meta.id,
    apiKeyName: meta.name || null,
    keyPrefix: meta.id.slice(0, 8),
    packages,
    requestsToAdd,
    totalIdr: totalToPayIdr,
    buyerPhone,
    buyerEmail,
    autoCredit,
  });

  return NextResponse.json({
    transactionId: tx.id,
    status: tx.status,
    credited: tx.credited,
    keyLabel: meta.name || tx.keyPrefix || "API Key",
    requestsToAdd,
    totalToPayIdr,
    expiredAt: tx.expiresAt,
    qrString: autoCredit ? null : getPaymentQrString(),
    payLink: autoCredit ? null : getPaymentUrl(),
    message: autoCredit
      ? "Topup otomatis aktif; request limit langsung ditambahkan."
      : "Transaksi dibuat dan menunggu pembayaran/konfirmasi.",
  });
}
