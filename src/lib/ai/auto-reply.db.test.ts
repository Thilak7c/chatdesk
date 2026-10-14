import { beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AiConfig } from './types'

// The LLM, KB checks and the Meta send are mocked; conversation state,
// the reply-slot claim and handoff writes run against the real database.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  evaluateDeterministicEscalation: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
}))
vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./deterministic-escalation', () => ({
  evaluateDeterministicEscalation: h.evaluateDeterministicEscalation,
}))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))

import { db } from '@/db'
import { automations, conversations, notifications } from '@/db/schema'
import {
  addMember,
  createAccount,
  createContact,
  createConversation,
  describeDb,
} from '@/test/factories'
import { dispatchInboundToAiReply } from './auto-reply'

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    confidenceThreshold: null,
    hardEscalateKeywords: [],
    ...overrides,
  }
}

async function seed(conv: Partial<typeof conversations.$inferInsert> = {}) {
  const { account, user } = await createAccount()
  const contact = await createContact(account.id, user.id)
  const conversation = await createConversation(account.id, user.id, contact.id, conv)
  const args = {
    accountId: account.id,
    conversationId: conversation.id,
    contactId: contact.id,
    configOwnerUserId: user.id,
  }
  const reload = async () =>
    (await db.select().from(conversations).where(eq(conversations.id, conversation.id)))[0]
  return { account, user, args, reload }
}

beforeEach(() => {
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.evaluateDeterministicEscalation.mockResolvedValue({
    escalate: false,
    knowledge: { chunks: [], bestDistance: null },
  })
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, usage: null })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1', message_id: 'x' })
})

describeDb('dispatchInboundToAiReply — sending', () => {
  it('claims a reply slot and sends on the happy path', async () => {
    const { args, reload } = await seed()
    await dispatchInboundToAiReply(args)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: args.conversationId, text: 'Hello!', aiGenerated: true }),
    )
    expect((await reload()).aiReplyCount).toBe(1)
  })

  it('grounds the reply in retrieved knowledge', async () => {
    const { args } = await seed()
    h.evaluateDeterministicEscalation.mockResolvedValue({
      escalate: false,
      knowledge: { chunks: ['Returns accepted within 30 days.'], bestDistance: 0.1 },
    })
    await dispatchInboundToAiReply(args)
    expect(h.generateReply.mock.calls[0][0].systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('never exceeds the per-conversation cap under concurrent inbounds', async () => {
    const { args, reload } = await seed({ aiReplyCount: 2 })
    await Promise.all(Array.from({ length: 4 }, () => dispatchInboundToAiReply(args)))
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect((await reload()).aiReplyCount).toBe(3)
  })
})

describeDb('dispatchInboundToAiReply — eligibility gates', () => {
  it('stands down when an active message-level automation exists', async () => {
    const { args, account, user } = await seed()
    await db.insert(automations).values({
      accountId: account.id,
      userId: user.id,
      name: 'Auto',
      triggerType: 'keyword_match',
      isActive: true,
    })
    await dispatchInboundToAiReply(args)
    expect(h.generateReply).not.toHaveBeenCalled()
  })

  it.each([
    ['AI is off', () => h.loadAiConfig.mockResolvedValue(null), {}],
    ['auto-reply disabled', () => h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false })), {}],
    ['paused on this thread', () => {}, { aiAutoreplyDisabled: true }],
    ['cap reached', () => {}, { aiReplyCount: 3 }],
    ['nothing to reply to', () => h.buildConversationContext.mockResolvedValue([]), {}],
  ] as const)('skips when %s', async (_name, arrange, conv) => {
    arrange()
    const { args } = await seed(conv)
    await dispatchInboundToAiReply(args)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    const { account } = await createAccount()
    const agent = await addMember(account.id)
    const { args } = await seed({ assignedAgentId: agent.user.id })
    await dispatchInboundToAiReply(args)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describeDb('dispatchInboundToAiReply — handoff', () => {
  it('pauses the bot and writes a summary when the model hands off (no target → unassigned)', async () => {
    const { args, reload } = await seed()
    h.generateReply.mockResolvedValue({ text: '', handoff: true, usage: null })
    await dispatchInboundToAiReply(args)
    const conv = await reload()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(conv.aiAutoreplyDisabled).toBe(true)
    expect(conv.aiHandoffSummary).toContain('AI agent handed off')
    expect(conv.assignedAgentId).toBeNull()
    expect(conv.aiReplyCount).toBe(0)
  })

  it('routes to the configured handoff agent and notifies them', async () => {
    const { args, account, reload } = await seed()
    const agent = await addMember(account.id)
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: agent.user.id }))
    h.evaluateDeterministicEscalation.mockResolvedValue({
      escalate: true,
      reason: 'hard-escalate keyword matched: "refund"',
    })
    await dispatchInboundToAiReply(args)

    const conv = await reload()
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(conv.assignedAgentId).toBe(agent.user.id)
    expect(conv.aiHandoffSummary).toContain('hard-escalate keyword matched: "refund"')
    const notes = await db.select().from(notifications).where(eq(notifications.userId, agent.user.id))
    expect(notes).toHaveLength(1)
  })
})
