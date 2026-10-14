import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { messageTemplates } from '@/db/schema'
import { createAccount, createTemplate, describeDb } from '@/test/factories'
import { resolveTemplateRow } from './template-body'
import { handleTemplateWebhookChange, isTemplateWebhookField } from './template-webhook'

describeDb('resolveTemplateRow', () => {
  async function seed(languages: string[]) {
    const { account, user } = await createAccount()
    const rows = []
    for (const language of languages) {
      rows.push(await createTemplate(account.id, user.id, { name: 'order_update', language }))
    }
    return { accountId: account.id, rows }
  }

  it("matches a synced 'en' row when the caller asks for 'en_US'", async () => {
    const { accountId } = await seed(['en'])
    const resolved = await resolveTemplateRow(db, accountId, 'order_update', 'en_US')
    expect(resolved.row?.language).toBe('en')
    expect(resolved.language).toBe('en_US')
  })

  it("resolves a bare 'en' row when no language is given, and sends 'en'", async () => {
    const { accountId } = await seed(['en'])
    const resolved = await resolveTemplateRow(db, accountId, 'order_update', null)
    expect(resolved.language).toBe('en')
  })

  it('prefers an exact match, then en_US, then en', async () => {
    const { accountId } = await seed(['es', 'en', 'en_US', 'en_GB'])
    expect((await resolveTemplateRow(db, accountId, 'order_update', 'en_GB')).row?.language).toBe('en_GB')
    expect((await resolveTemplateRow(db, accountId, 'order_update')).row?.language).toBe('en_US')
  })

  it('is scoped to the account and keeps the requested language when nothing matches', async () => {
    const { accountId } = await seed(['es'])
    const other = await createAccount()
    expect(await resolveTemplateRow(db, other.account.id, 'order_update', 'fr')).toEqual({
      row: null,
      malformed: false,
      language: 'fr',
    })
    const pinned = await resolveTemplateRow(db, accountId, 'order_update', 'de')
    expect(pinned).toMatchObject({ row: null, language: 'de' })
  })
})

describe('isTemplateWebhookField', () => {
  it('recognises the three template fields and rejects messaging fields', () => {
    expect(isTemplateWebhookField('message_template_status_update')).toBe(true)
    expect(isTemplateWebhookField('message_template_quality_update')).toBe(true)
    expect(isTemplateWebhookField('message_template_components_update')).toBe(true)
    expect(isTemplateWebhookField('messages')).toBe(false)
  })
})

describeDb('handleTemplateWebhookChange', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  async function seedTemplate(over: Partial<typeof messageTemplates.$inferInsert> = {}) {
    const { account, user } = await createAccount()
    return createTemplate(account.id, user.id, { metaTemplateId: '12345', status: 'PENDING', ...over })
  }
  const reload = async (id: string) =>
    (await db.select().from(messageTemplates).where(eq(messageTemplates.id, id)))[0]

  it('approves (numeric id coerced to text) and clears stale errors', async () => {
    const tpl = await seedTemplate({ rejectionReason: 'old', submissionError: 'old' })
    await handleTemplateWebhookChange(
      { field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 12345 } },
      db,
    )
    expect(await reload(tpl.id)).toMatchObject({ status: 'APPROVED', rejectionReason: null, submissionError: null })
  })

  it('stores the rejection reason, with a generic fallback', async () => {
    const tpl = await seedTemplate()
    await handleTemplateWebhookChange(
      { field: 'message_template_status_update', value: { event: 'REJECTED', message_template_id: '12345', reason: 'Non-compliant.' } },
      db,
    )
    expect((await reload(tpl.id)).rejectionReason).toBe('Non-compliant.')
    await handleTemplateWebhookChange(
      { field: 'message_template_status_update', value: { event: 'REJECTED', message_template_id: '12345' } },
      db,
    )
    expect((await reload(tpl.id)).rejectionReason).toBe('Rejected by Meta')
  })

  it('normalises PENDING_REVIEW to PENDING and warns for unknown templates', async () => {
    const tpl = await seedTemplate({ status: 'APPROVED' })
    await handleTemplateWebhookChange(
      { field: 'message_template_status_update', value: { event: 'PENDING_REVIEW', message_template_id: '12345' } },
      db,
    )
    expect((await reload(tpl.id)).status).toBe('PENDING')

    await handleTemplateWebhookChange(
      { field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 'NEVER_SEEN' } },
      db,
    )
    expect(console.warn).toHaveBeenCalled()
  })

  it('sets the quality score, storing null for unrecognised values', async () => {
    const tpl = await seedTemplate()
    await handleTemplateWebhookChange(
      { field: 'message_template_quality_update', value: { message_template_id: '12345', new_quality_score: 'YELLOW' } },
      db,
    )
    expect((await reload(tpl.id)).qualityScore).toBe('YELLOW')
    await handleTemplateWebhookChange(
      { field: 'message_template_quality_update', value: { message_template_id: '12345', new_quality_score: 'PURPLE' } },
      db,
    )
    expect((await reload(tpl.id)).qualityScore).toBeNull()
  })

  it('does not write for components updates, missing ids, or unknown fields', async () => {
    const tpl = await seedTemplate()
    const before = await reload(tpl.id)
    await handleTemplateWebhookChange(
      { field: 'message_template_components_update', value: { message_template_id: '12345' } },
      db,
    )
    await handleTemplateWebhookChange({ field: 'message_template_status_update', value: { event: 'APPROVED' } }, db)
    await handleTemplateWebhookChange({ field: 'message_template_future_field', value: {} }, db)
    expect((await reload(tpl.id)).updatedAt).toEqual(before.updatedAt)
  })
})
