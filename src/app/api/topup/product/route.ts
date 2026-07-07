import { NextResponse } from "next/server";
import { getPortalProduct, isTopupMaintenance } from "@/lib/portal/requestLimits";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    product: getPortalProduct(),
    maintenance: isTopupMaintenance(),
    message: isTopupMaintenance()
      ? "Topup request limit belum aktif. Set OMNIROUTE_TOPUP_ENABLED=true untuk mengaktifkan."
      : null,
  });
}
