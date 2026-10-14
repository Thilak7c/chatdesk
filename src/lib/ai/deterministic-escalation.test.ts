import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DbOrTx } from '@/db'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({ retrieveKnowledge: vi.fn() }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))

import { evaluateDeterministicEscalation } from './deterministic-escalation'

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
    embeddingsApiKey: 'sk-embed',
    confidenceThreshold: null,
    hardEscalateKeywords: [],
    ...overrides,
  }
}

const FAKE_DB = {} as DbOrTx

beforeEach(() => {
  h.retrieveKnowledge.mockReset()
  h.retrieveKnowledge.mockResolvedValue({ chunks: ['some chunk'], bestDistance: 0.1 })
})

describe('evaluateDeterministicEscalation — hard-escalate keywords', () => {
  it('escalates on a case-insensitive keyword match, without calling retrieveKnowledge', async () => {
    const result = await evaluateDeterministicEscalation({
      db: FAKE_DB,
      accountId: 'acct-1',
      config: aiConfig({ hardEscalateKeywords: ['refund', 'lawyer'] }),
      inbound: 'Can I get a REFUND for my order?',
    })
    expect(result).toEqual({
      escalate: true,
      reason: 'hard-escalate keyword matched: "refund"',
    })
    expect(h.retrieveKnowledge).not.toHaveBeenCalled()
  })

  it('does not escalate when no keyword matches', async () => {
    const result = await evaluateDeterministicEscalation({
      db: FAKE_DB,
      accountId: 'acct-1',
      config: aiConfig({ hardEscalateKeywords: ['refund', 'lawyer'] }),
      inbound: 'What are your opening hours?',
    })
    expect(result.escalate).toBe(false)
  })

  it('never fires when the keyword list is empty', async () => {
    const result = await evaluateDeterministicEscalation({
      db: FAKE_DB,
      accountId: 'acct-1',
      config: aiConfig({ hardEscalateKeywords: [] }),
      inbound: 'I want a refund',
    })
    expect(result.escalate).toBe(false)
  })
})

describe('evaluateDeterministicEscalation — confidence threshold', () => {
  it('escalates when the best distance exceeds the threshold', async () => {
    h.retrieveKnowledge.mockResolvedValue({ chunks: ['x'], bestDistance: 0.9 })
    const result = await evaluateDeterministicEscalation({
      db: FAKE_DB,
      accountId: 'acct-1',
      config: aiConfig({ confidenceThreshold: 0.75 }),
      inbound: 'some obscure question',
    })
    expect(result).toEqual({
      escalate: true,
      reason: 'low knowledge-base confidence (distance 0.900 > threshold 0.750)',
    })
  })

  it('does not escalate when the best distance is within the threshold', async () => {
    h.retrieveKnowledge.mockResolvedValue({ chunks: ['x'], bestDistance: 0.5 })
    const result = await evaluateDeterministicEscalation({
      db: FAKE_DB,
      accountId: 'acct-1',
      config: aiConfig({ confidenceThreshold: 0.75 }),
      inbound: 'a well-covered question',
    })
    expect(result.escalate).toBe(false)
    if (!result.escalate) {
      expect(result.knowledge).toEqual({ chunks: ['x'], bestDistance: 0.5 })
    }
  })

  it('is skipped (no escalation from this check) when threshold is null', async () => {
    h.retrieveKnowledge.mockResolvedValue({ chunks: [], bestDistance: 1.8 })
    const result = await evaluateDeterministicEscalation({
      db: FAKE_DB,
      accountId: 'acct-1',
      config: aiConfig({ confidenceThreshold: null }),
      inbound: 'anything',
    })
    expect(result.escalate).toBe(false)
  })

  it('is skipped when there is no semantic distance (lexical-only retrieval)', async () => {
    h.retrieveKnowledge.mockResolvedValue({ chunks: ['x'], bestDistance: null })
    const result = await evaluateDeterministicEscalation({
      db: FAKE_DB,
      accountId: 'acct-1',
      config: aiConfig({ confidenceThreshold: 0.1, embeddingsApiKey: null }),
      inbound: 'anything',
    })
    expect(result.escalate).toBe(false)
  })
})
