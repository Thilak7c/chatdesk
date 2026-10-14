import { beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

// Deterministic embeddings: each text maps to a 1536-dim one-hot-ish
// vector chosen by its first word, so cosine distances are predictable.
const h = vi.hoisted(() => ({ embedTexts: vi.fn() }))
vi.mock('./embeddings', () => ({ embedTexts: h.embedTexts }))

import { db } from '@/db'
import { aiKnowledgeChunks, aiKnowledgeDocuments } from '@/db/schema'
import { createAccount, describeDb } from '@/test/factories'
import { ingestDocument, retrieveKnowledge } from './knowledge'

const AXES: Record<string, number> = { shipping: 0, refunds: 1, hours: 2 }
function vectorFor(text: string): number[] {
  const v = new Array(1536).fill(0)
  const axis = AXES[text.trim().split(/\s+/)[0].toLowerCase()] ?? 3
  v[axis] = 1
  v[1535] = 0.01 // never a zero vector
  return v
}

beforeEach(() => {
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) => inputs.map(vectorFor))
})

async function seedDoc(accountId: string, content: string, embeddingsApiKey: string | null) {
  const [doc] = await db
    .insert(aiKnowledgeDocuments)
    .values({ accountId, title: content.slice(0, 20), content })
    .returning()
  await ingestDocument(db, accountId, { embeddingsApiKey }, doc.id, content)
  return doc
}

describeDb('ingestDocument', () => {
  it('stores embedded chunks when a key is present, and replaces them on re-ingest', async () => {
    const { account } = await createAccount()
    const doc = await seedDoc(account.id, 'shipping takes three days', 'sk-x')
    let chunks = await db.select().from(aiKnowledgeChunks).where(eq(aiKnowledgeChunks.documentId, doc.id))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].embedding).toHaveLength(1536)

    await ingestDocument(db, account.id, { embeddingsApiKey: null }, doc.id, 'hours are nine to five')
    chunks = await db.select().from(aiKnowledgeChunks).where(eq(aiKnowledgeChunks.documentId, doc.id))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe('hours are nine to five')
    expect(chunks[0].embedding).toBeNull()
  })

  it('still stores lexical chunks when embedding fails, then rethrows', async () => {
    const { account } = await createAccount()
    const [doc] = await db
      .insert(aiKnowledgeDocuments)
      .values({ accountId: account.id, title: 't', content: 'x' })
      .returning()
    h.embedTexts.mockRejectedValueOnce(new Error('rate limited'))
    await expect(
      ingestDocument(db, account.id, { embeddingsApiKey: 'sk-x' }, doc.id, 'refunds within 30 days'),
    ).rejects.toThrow('rate limited')
    const chunks = await db.select().from(aiKnowledgeChunks).where(eq(aiKnowledgeChunks.documentId, doc.id))
    expect(chunks).toHaveLength(1)
    expect(chunks[0].embedding).toBeNull()
  })
})

describeDb('retrieveKnowledge', () => {
  it('returns nothing, without embedding, for an empty query or an empty knowledge base', async () => {
    const { account } = await createAccount()
    expect(await retrieveKnowledge(db, account.id, { embeddingsApiKey: 'sk-x' }, '  ')).toEqual({
      chunks: [],
      bestDistance: null,
    })
    expect(await retrieveKnowledge(db, account.id, { embeddingsApiKey: 'sk-x' }, 'shipping')).toEqual({
      chunks: [],
      bestDistance: null,
    })
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('uses lexical search only when there is no embeddings key (no distance score)', async () => {
    const { account } = await createAccount()
    await seedDoc(account.id, 'refunds are issued within 30 days', null)
    await seedDoc(account.id, 'hours are nine to five', null)
    const out = await retrieveKnowledge(db, account.id, { embeddingsApiKey: null }, 'refunds')
    expect(out).toEqual({ chunks: ['refunds are issued within 30 days'], bestDistance: null })
  })

  it('ranks semantically, reports the best distance, and tops up with lexical matches', async () => {
    const { account } = await createAccount()
    await seedDoc(account.id, 'shipping takes three days', 'sk-x')
    await seedDoc(account.id, 'refunds are issued within 30 days', 'sk-x')

    const out = await retrieveKnowledge(db, account.id, { embeddingsApiKey: 'sk-x' }, 'shipping please', 1)
    expect(out.chunks).toEqual(['shipping takes three days'])
    expect(out.bestDistance).toBeLessThan(0.01)
  })

  it('never returns another account’s knowledge', async () => {
    const a = await createAccount()
    const b = await createAccount()
    await seedDoc(b.account.id, 'refunds are issued within 30 days', 'sk-x')
    await seedDoc(a.account.id, 'hours are nine to five', 'sk-x')
    const out = await retrieveKnowledge(db, a.account.id, { embeddingsApiKey: 'sk-x' }, 'refunds')
    expect(out.chunks).toEqual(['hours are nine to five'])
  })
})
