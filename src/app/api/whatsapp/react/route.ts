// src/app/api/whatsapp/react/route.ts

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { db } from '@/db';
import { messages, conversations, contacts, whatsappConfig, messageReactions } from '@/db/schema';
import { sendReactionMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { emitReactionEvent } from '@/lib/socket';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction to Meta and mirrors it into `message_reactions`
 * (delete on empty emoji). Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`react:${userId}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    const targetMessage = await db.query.messages.findFirst({
      where: eq(messages.id, message_id),
      columns: { id: true, messageId: true, conversationId: true },
    });

    if (!targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (!targetMessage.messageId) {
      return NextResponse.json(
        { error: 'Cannot react to a message that has not been sent to WhatsApp' },
        { status: 400 },
      );
    }

    const convRow = await db
      .select({ id: conversations.id, phone: contacts.phone })
      .from(conversations)
      .leftJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(
        and(
          eq(conversations.id, targetMessage.conversationId),
          eq(conversations.accountId, accountId),
        ),
      )
      .limit(1);

    if (!convRow[0]) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    if (!convRow[0].phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }

    const config = await db.query.whatsappConfig.findFirst({
      where: eq(whatsappConfig.accountId, accountId),
      columns: { phoneNumberId: true, accessToken: true },
    });

    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    const accessToken = decrypt(config.accessToken);
    const sanitizedPhone = sanitizePhoneForMeta(convRow[0].phone);

    try {
      await sendReactionMessage({
        phoneNumberId: config.phoneNumberId,
        accessToken,
        to: sanitizedPhone,
        targetMessageId: targetMessage.messageId,
        emoji,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown Meta API error';
      console.error('[whatsapp/react] Meta send failed:', message);
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 502 },
      );
    }

    // Mirror into DB. Empty emoji = removal.
    if (emoji === '') {
      try {
        await db
          .delete(messageReactions)
          .where(
            and(
              eq(messageReactions.messageId, targetMessage.id),
              eq(messageReactions.actorType, 'agent'),
              eq(messageReactions.actorId, userId),
            ),
          );
      } catch (err) {
        console.error('[whatsapp/react] DB delete failed:', err);
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB delete failed' },
          { status: 500 },
        );
      }

      // No row id survives a delete-by-filter, so the client identifies
      // which pill to drop by (message_id, actor_type, actor_id) — same
      // triple the reducer already keys its own optimistic row on.
      emitReactionEvent(accountId, {
        eventType: 'DELETE',
        new: null,
        old: {
          message_id: targetMessage.id,
          actor_type: 'agent',
          actor_id: userId,
        },
      });
    } else {
      let upserted;
      try {
        const rows = await db
          .insert(messageReactions)
          .values({
            messageId: targetMessage.id,
            conversationId: targetMessage.conversationId,
            actorType: 'agent',
            actorId: userId,
            emoji,
          })
          .onConflictDoUpdate({
            target: [
              messageReactions.messageId,
              messageReactions.actorType,
              messageReactions.actorId,
            ],
            set: { emoji },
          })
          .returning();
        upserted = rows[0];
      } catch (err) {
        console.error('[whatsapp/react] DB upsert failed:', err);
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB upsert failed' },
          { status: 500 },
        );
      }

      if (!upserted) {
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB upsert failed' },
          { status: 500 },
        );
      }

      emitReactionEvent(accountId, {
        eventType: 'UPSERT',
        new: {
          id: upserted.id,
          message_id: upserted.messageId,
          conversation_id: upserted.conversationId,
          actor_type: upserted.actorType,
          actor_id: upserted.actorId,
          emoji: upserted.emoji,
          created_at: upserted.createdAt,
        },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error);
    return toErrorResponse(error);
  }
}