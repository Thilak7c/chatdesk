import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { messageTemplates, whatsappConfig } from '@/db/schema'
import { toSnake } from '@/db/serialize'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  deleteMessageTemplate,
  editMessageTemplate,
} from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'

/**
 * Per-template lifecycle endpoint.
 *
 * PATCH  — edit an existing Meta-side template (and re-submit). Used
 *          by the "Edit" action on APPROVED rows and the "Resubmit"
 *          action on REJECTED / PAUSED rows. Meta replaces components
 *          wholesale on edit and bumps status back to PENDING.
 *
 * DELETE — remove the template on Meta (when meta_template_id is set,
 *          scoped to a single language variant via hsm_id) AND drop
 *          the local row. Local-only rows skip the Meta call.
 *
 * Initial submission (DRAFT → PENDING) lives at the sibling
 * /submit endpoint — keep this route narrowly about lifecycle of
 * already-submitted templates.
 */

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED'])

// uuid v4 plus the looser shape Postgres gen_random_uuid emits.
// We don't need exhaustive RFC parsing — just enough to reject
// "../etc/passwd"-style payloads before they hit the database.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  )
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid template id.' },
        { status: 400 },
      )
    }
    // Templates are settings-class data (admin+), same as /submit.
    let accountId: string
    try {
      ;({ accountId } = await requireRole('admin'))
    } catch (err) {
      return toErrorResponse(err)
    }

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    const [existing] = await db
      .select({
        id: messageTemplates.id,
        name: messageTemplates.name,
        status: messageTemplates.status,
        metaTemplateId: messageTemplates.metaTemplateId,
        language: messageTemplates.language,
      })
      .from(messageTemplates)
      .where(and(eq(messageTemplates.id, id), eq(messageTemplates.accountId, accountId)))
      .limit(1)
    if (!existing) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 })
    }

    if (!existing.metaTemplateId) {
      return NextResponse.json(
        {
          error:
            'This template was never submitted to Meta — use New Template to submit it instead.',
        },
        { status: 400 },
      )
    }

    if (!EDITABLE_STATUSES.has(existing.status)) {
      return NextResponse.json(
        {
          error: `Templates in status ${existing.status} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED.`,
        },
        { status: 400 },
      )
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not editable here — manage them in Meta WhatsApp Manager.',
        },
        { status: 400 },
      )
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 },
      )
    }

    if (!isDryRun()) {
      const [config] = await db
        .select()
        .from(whatsappConfig)
        .where(eq(whatsappConfig.accountId, accountId))
        .limit(1)
      if (!config) {
        return NextResponse.json(
          { error: 'WhatsApp not configured.' },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.accessToken)

      // Image headers need a fresh Resumable-Upload handle on every edit
      // (Meta replaces components wholesale). Derive from header_media_url.
      try {
        await ensureImageHeaderHandle(payload, accessToken)
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Header image upload failed.' },
          { status: 400 },
        )
      }

      const metaPayload = buildMetaTemplatePayload(payload)
      try {
        await editMessageTemplate({
          metaTemplateId: existing.metaTemplateId,
          accessToken,
          components: metaPayload.components,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta edit failed.'
        await db
          .update(messageTemplates)
          .set({ submissionError: message, lastSubmittedAt: new Date() })
          .where(eq(messageTemplates.id, id))
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    // Meta accepted the edit — status flips back to PENDING for review.
    let row
    try {
      ;[row] = await db
        .update(messageTemplates)
        .set({
          category: payload.category,
          headerType: payload.header_type ?? null,
          headerContent: payload.header_content ?? null,
          headerMediaUrl: payload.header_media_url ?? null,
          headerHandle: payload.header_handle ?? null,
          bodyText: payload.body_text,
          footerText: payload.footer_text ?? null,
          buttons: payload.buttons ?? null,
          sampleValues: payload.sample_values ?? null,
          status: 'PENDING',
          submissionError: null,
          rejectionReason: null,
          lastSubmittedAt: new Date(),
        })
        .where(eq(messageTemplates.id, id))
        .returning()
    } catch (updErr) {
      return NextResponse.json(
        {
          error: `Edited on Meta but failed to save locally: ${(updErr as Error).message}. Run "Sync from Meta" to recover.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row && toSnake(row),
      dry_run: isDryRun(),
    })
  } catch (error) {
    console.error('Error editing template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to edit template.',
      },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid template id.' },
        { status: 400 },
      )
    }
    // Templates are settings-class data (admin+), same as /submit.
    let accountId: string
    try {
      ;({ accountId } = await requireRole('admin'))
    } catch (err) {
      return toErrorResponse(err)
    }

    const [existing] = await db
      .select({
        id: messageTemplates.id,
        name: messageTemplates.name,
        metaTemplateId: messageTemplates.metaTemplateId,
      })
      .from(messageTemplates)
      .where(and(eq(messageTemplates.id, id), eq(messageTemplates.accountId, accountId)))
      .limit(1)
    if (!existing) {
      return NextResponse.json({ error: 'Template not found.' }, { status: 404 })
    }

    if (existing.metaTemplateId && !isDryRun()) {
      const [config] = await db
        .select()
        .from(whatsappConfig)
        .where(eq(whatsappConfig.accountId, accountId))
        .limit(1)
      if (!config || !config.wabaId) {
        return NextResponse.json(
          { error: 'WhatsApp not configured — cannot delete on Meta.' },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.accessToken)
      try {
        await deleteMessageTemplate({
          wabaId: config.wabaId,
          accessToken,
          name: existing.name,
          metaTemplateId: existing.metaTemplateId,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta delete failed.'
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    try {
      await db
        .delete(messageTemplates)
        .where(and(eq(messageTemplates.id, id), eq(messageTemplates.accountId, accountId)))
    } catch (delErr) {
      return NextResponse.json(
        {
          error: `Deleted on Meta but failed to delete locally: ${(delErr as Error).message}.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, dry_run: isDryRun() })
  } catch (error) {
    console.error('Error deleting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to delete template.',
      },
      { status: 500 },
    )
  }
}
