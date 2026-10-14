// src/app/api/whatsapp/config/row/route.ts

import { NextResponse } from "next/server";
import { db } from "@/db";
import { whatsappConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireRole, toErrorResponse } from "@/lib/auth/account";

export async function GET() {
  try {
    const ctx = await requireRole("viewer");

    const [row] = await db
      .select()
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, ctx.accountId));

    if (!row) {
      return NextResponse.json({ config: null });
    }

    return NextResponse.json({
      config: {
        id: row.id,
        account_id: row.accountId,
        phone_number_id: row.phoneNumberId,
        waba_id: row.wabaId,
        status: row.status,
        connected_at: row.connectedAt,
        registered_at: row.registeredAt,
        subscribed_apps_at: row.subscribedAppsAt,
        last_registration_error: row.lastRegistrationError,
        mirror_inbound_media: row.mirrorInboundMedia,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}