import { expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { aiConfigs, aiUsageLog } from '@/db/schema'
import { encrypt } from '@/lib/whatsapp/encryption'
import { createAccount, createContact, createConversation, createMessage, describeDb } from '@/test/factories'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { logAiUsage } from './usage'

describeDb('loadAiConfig', () => {
  async function seed(isActive: boolean) {
    const { account, user } = await createAccount()
    await db.insert(aiConfigs).values({
      accountId: account.id,
      createdBy: user.id,
      provider: 'openai',
      model: 'gpt-x',
      apiKey: encrypt('sk-test'),
      isActive,
      hardEscalateKeywords: ['refund'],
    })
    return account.id
  }

  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(db, await seed(false))).toBeNull()
  })

  it('returns the decrypted config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(db, await seed(false), { requireActive: false })
    expect(config).toMatchObject({ provider: 'openai', apiKey: 'sk-test', hardEscalateKeywords: ['refund'] })
  })

  it('returns null when the account has no config', async () => {
    const { account } = await createAccount()
    expect(await loadAiConfig(db, account.id, { requireActive: false })).toBeNull()
  })
})

describeDb('buildConversationContext', () => {
  it('maps senders to roles, keeps chronological order, drops blanks and non-text', async () => {
    const { account, user } = await createAccount()
    const contact = await createContact(account.id, user.id)
    const conv = await createConversation(account.id, user.id, contact.id)
    const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s))
    await createMessage(conv.id, { senderType: 'customer', contentText: 'first', createdAt: t(1) })
    await createMessage(conv.id, { senderType: 'agent', contentText: 'second', createdAt: t(2) })
    await createMessage(conv.id, { senderType: 'customer', contentText: '   ', createdAt: t(3) })
    await createMessage(conv.id, { senderType: 'customer', contentType: 'image', contentText: 'caption', createdAt: t(4) })
    await createMessage(conv.id, { senderType: 'bot', contentText: 'auto reply', createdAt: t(5) })

    expect(await buildConversationContext(db, conv.id)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'assistant', content: 'auto reply' },
    ])
  })
})

describeDb('logAiUsage', () => {
  it('records token usage', async () => {
    const { account } = await createAccount()
    await logAiUsage(db, {
      accountId: account.id,
      conversationId: null,
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const rows = await db.select().from(aiUsageLog).where(eq(aiUsageLog.accountId, account.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ promptTokens: 30, completionTokens: 6, totalTokens: 36, mode: 'auto_reply' })
  })

  it('is a no-op without usage, and never throws on a bad row', async () => {
    const { account } = await createAccount()
    const base = { accountId: account.id, conversationId: null, mode: 'draft' as const, model: 'm' }
    await logAiUsage(db, { ...base, provider: 'openai', usage: null })
    // Unknown provider violates the CHECK constraint — must be swallowed.
    await expect(
      logAiUsage(db, { ...base, provider: 'nope' as 'openai', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
    ).resolves.toBeUndefined()
    expect(await db.select().from(aiUsageLog)).toHaveLength(0)
  })
})
