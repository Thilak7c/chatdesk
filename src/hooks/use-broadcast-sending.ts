// src/hooks/use-broadcast-sending.ts

'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import {
  BATCH_SEND_ATTEMPTS,
  batchRetryDelayMs,
} from '@/lib/broadcast-retry';
import { Contact, MessageTemplate } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

interface RecipientRow {
  id: string;
  contact_id: string;
  status: string;
  template_params: string[];
  contact: Contact | null;
}

export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Record<string, string>,
): string[] {
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    return customValues?.[v.value] ?? '';
  });
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function resolveAudience(
    audience: AudienceConfig,
  ): Promise<{ contacts: Contact[]; customValues: Record<string, Record<string, string>> }> {
    const res = await fetch('/api/broadcasts/audience', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(audience),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to resolve audience');
    }
    return { contacts: data.contacts ?? [], customValues: data.custom_values ?? {} };
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    try {
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const { contacts, customValues } = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(10);
      const createRes = await fetch('/api/broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
        }),
      });
      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !createData.broadcast) {
        throw new Error(createData?.error || 'Failed to create broadcast');
      }
      const broadcast = createData.broadcast;

      // ── Step 3: Insert recipient rows ─────────────────────────────
      setProgress(20);
      const recipientRows = contacts.map((contact) => ({
        contact_id: contact.id,
        template_params: resolveVariables(
          payload.variables,
          contact,
          customValues[contact.id],
        ),
      }));

      const insertRes = await fetch(`/api/broadcasts/${broadcast.id}/recipients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: recipientRows }),
      });
      if (!insertRes.ok) {
        const insertData = await insertRes.json().catch(() => ({}));
        await fetch(`/api/broadcasts/${broadcast.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'failed', failed_count: contacts.length }),
        });
        throw new Error(insertData?.error || 'Failed to insert recipients');
      }

      // ── Step 4: Fetch recipients back (joined contact) ────────────
      setProgress(30);
      const recipientsRes = await fetch(`/api/broadcasts/${broadcast.id}/recipients`);
      const recipientsData = await recipientsRes.json().catch(() => ({}));
      if (!recipientsRes.ok) {
        throw new Error('Failed to fetch broadcast recipients');
      }
      const recipients: RecipientRow[] = recipientsData.recipients ?? [];

      let failedCount = 0;
      const totalRecipients = recipients.length;

      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const messageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => ({
            phone: r.contact!.phone as string,
            params: Array.isArray(r.template_params) ? r.template_params : [],
            ...(messageParams ? { messageParams } : {}),
          }));

        if (apiRecipients.length === 0) continue;

        try {
          let data: { error?: string; results?: BroadcastApiResult[] } = {};
          for (let attempt = 1; ; attempt++) {
            const res = await fetch('/api/whatsapp/broadcast', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipients: apiRecipients,
                template_name: payload.template.name,
                template_language: payload.template.language ?? 'en_US',
              }),
            });

            data = await res.json();
            if (res.ok) break;

            const retryIn =
              attempt < BATCH_SEND_ATTEMPTS
                ? batchRetryDelayMs(res.status, res.headers.get('Retry-After'))
                : null;
            if (retryIn === null) {
              throw new Error(data.error || 'Broadcast API request failed');
            }
            await sleep(retryIn);
          }

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of (data.results ?? []) as BroadcastApiResult[]) {
            resultsByPhone.set(r.phone, r);
          }

          for (const recipient of batch) {
            const phone = recipient.contact?.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              failedCount++;
              await fetch(`/api/broadcasts/recipients/${recipient.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  status: 'failed',
                  error_message: 'No phone number on contact',
                }),
              });
              continue;
            }

            if (result.status === 'sent') {
              await fetch(`/api/broadcasts/recipients/${recipient.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  status: 'sent',
                  sent_at: new Date().toISOString(),
                  whatsapp_message_id: result.whatsapp_message_id ?? null,
                  error_message: null,
                }),
              });
            } else {
              failedCount++;
              await fetch(`/api/broadcasts/recipients/${recipient.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  status: 'failed',
                  error_message: result.error ?? 'Unknown error',
                }),
              });
            }
          }
        } catch (err) {
          for (const recipient of batch) {
            failedCount++;
            await fetch(`/api/broadcasts/recipients/${recipient.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                status: 'failed',
                error_message: err instanceof Error ? err.message : 'Unknown error',
              }),
            });
          }
        }

        const progressPct =
          30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 5: Finalize status ───────────────────────────────────
      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await fetch(`/api/broadcasts/${broadcast.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: finalStatus }),
      });

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}