import { beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

const sends = vi.hoisted(() => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'wamid.text', message_id: null })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: 'wamid.media', message_id: null })),
  engineSendInteractiveButtons: vi.fn(async () => ({ whatsapp_message_id: 'wamid.btn', message_id: null })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: 'wamid.list', message_id: null })),
}))
vi.mock('./meta-send', () => sends)

import { db } from '@/db'
import { conversations, flowNodes, flowRuns, flows } from '@/db/schema'
import { sweepStaleFlowRuns } from '@/lib/cron/jobs'
import { createAccount, createContact, createConversation, describeDb } from '@/test/factories'
import { dispatchInboundToFlows } from './engine'
import type { ParsedInbound } from './types'

type Node = { node_key: string; node_type: string; config: Record<string, unknown> }

// start → greet (send_message) → done (end)
const SIMPLE: Node[] = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'greet' } },
  { node_key: 'greet', node_type: 'send_message', config: { text: 'Looking that up…', next_node_key: 'done' } },
  { node_key: 'done', node_type: 'end', config: {} },
]

// start → menu (buttons) → yes:end / ask:collect_input(name) → thanks → end
const MENU: Node[] = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'menu' } },
  {
    node_key: 'menu',
    node_type: 'send_buttons',
    config: {
      text: 'Pick one',
      buttons: [
        { reply_id: 'yes', title: 'Yes', next_node_key: 'done' },
        { reply_id: 'ask', title: 'Ask', next_node_key: 'name' },
      ],
    },
  },
  { node_key: 'name', node_type: 'collect_input', config: { prompt_text: 'Your name?', var_key: 'name', next_node_key: 'thanks' } },
  { node_key: 'thanks', node_type: 'send_message', config: { text: 'Thanks {{vars.name}}', next_node_key: 'done' } },
  { node_key: 'done', node_type: 'end', config: {} },
]

async function seed(
  nodes: Node[],
  over: Partial<typeof flows.$inferInsert> = {},
) {
  const { account, user } = await createAccount()
  const contact = await createContact(account.id, user.id)
  const conversation = await createConversation(account.id, user.id, contact.id)
  const [flow] = await db
    .insert(flows)
    .values({
      accountId: account.id,
      userId: user.id,
      name: 'Order flow',
      status: 'active',
      triggerType: 'keyword',
      triggerConfig: { keywords: ['order status'] },
      entryNodeId: 'start',
      ...over,
    })
    .returning()
  await db.insert(flowNodes).values(
    nodes.map((n) => ({ flowId: flow.id, nodeKey: n.node_key, nodeType: n.node_type, config: n.config })),
  )
  const dispatch = (message: ParsedInbound, isFirstInboundMessage = false) =>
    dispatchInboundToFlows({
      accountId: account.id,
      userId: user.id,
      contactId: contact.id,
      conversationId: conversation.id,
      message,
      isFirstInboundMessage,
    })
  const runs = () => db.select().from(flowRuns).where(eq(flowRuns.flowId, flow.id))
  return { flow, conversation, dispatch, runs }
}

const tap = (reply_id: string, reply_title: string, id = 'm1'): ParsedInbound => ({
  kind: 'interactive_reply',
  reply_id,
  reply_title,
  meta_message_id: id,
})
const text = (t: string, id = 'm1'): ParsedInbound => ({ kind: 'text', text: t, meta_message_id: id })

beforeEach(() => {
  for (const fn of Object.values(sends)) fn.mockClear()
})

describeDb('dispatchInboundToFlows — entry triggers', () => {
  it('starts a keyword flow from a tap on a matching button, runs it, and counts it', async () => {
    const { flow, dispatch, runs } = await seed(SIMPLE)
    const result = await dispatch(tap('btn_1', 'Order status'))
    expect(result).toMatchObject({ consumed: true, outcome: 'completed' })
    expect(sends.engineSendText).toHaveBeenCalledTimes(1)
    expect((await runs())[0].status).toBe('completed')
    expect((await db.select().from(flows).where(eq(flows.id, flow.id)))[0].executionCount).toBe(1)
  })

  it('matches on the reply id, and on typed text', async () => {
    const a = await seed(SIMPLE, { triggerConfig: { keywords: ['order_status'] } })
    expect((await a.dispatch(tap('order_status', 'Where is my parcel?'))).consumed).toBe(true)
    const b = await seed(SIMPLE)
    expect((await b.dispatch(text('order status please'))).consumed).toBe(true)
  })

  it('leaves non-matching taps and manual flows to the automations dispatcher', async () => {
    const a = await seed(SIMPLE)
    expect(await a.dispatch(tap('btn_9', 'Talk to a human'))).toMatchObject({ consumed: false, outcome: 'no_match' })
    const b = await seed(SIMPLE, { triggerType: 'manual' })
    expect((await b.dispatch(tap('btn_1', 'Order status'))).consumed).toBe(false)
    expect(await a.runs()).toHaveLength(0)
  })

  it('starts a first_inbound_message flow when the first inbound is a tap', async () => {
    const { dispatch } = await seed(SIMPLE, { triggerType: 'first_inbound_message', triggerConfig: {} })
    expect((await dispatch(tap('btn_1', 'Yes, tell me more'), true)).consumed).toBe(true)
  })
})

describeDb('dispatchInboundToFlows — running a flow', () => {
  it('suspends at buttons, advances on a tap, captures input, and completes', async () => {
    const { dispatch, runs } = await seed(MENU)
    expect((await dispatch(text('order status', 'm1'))).outcome).toBe('started')
    expect(sends.engineSendInteractiveButtons).toHaveBeenCalledTimes(1)
    expect((await runs())[0]).toMatchObject({ status: 'active', currentNodeKey: 'menu' })

    await dispatch(tap('ask', 'Ask', 'm2'))
    expect((await runs())[0].currentNodeKey).toBe('name')

    const done = await dispatch(text('Jane', 'm3'))
    expect(done.outcome).toBe('completed')
    expect(sends.engineSendText).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Thanks Jane' }))
    expect((await runs())[0]).toMatchObject({ status: 'completed', vars: { name: 'Jane' } })
  })

  it('ignores a replayed inbound (same Meta message id)', async () => {
    const { dispatch, runs } = await seed(MENU)
    await dispatch(text('order status', 'm1'))
    await dispatch(tap('ask', 'Ask', 'm2'))
    const replay = await dispatch(tap('ask', 'Ask', 'm2'))
    expect(replay.outcome).toBe('duplicate_inbound_ignored')
    expect((await runs())[0].currentNodeKey).toBe('name')
  })

  it('reprompts on an unknown reply, then hands off once reprompts run out', async () => {
    const { dispatch, runs, conversation } = await seed(MENU, {
      fallbackPolicy: { on_unknown_reply: 'reprompt', max_reprompts: 1, on_timeout_hours: 24, on_exhaust: 'handoff' },
    })
    await dispatch(text('order status', 'm1'))
    expect((await dispatch(tap('nope', 'Nope', 'm2'))).outcome).toBe('fallback_fired')
    expect(sends.engineSendInteractiveButtons).toHaveBeenCalledTimes(2)
    expect((await dispatch(tap('nope', 'Nope', 'm3'))).outcome).toBe('handed_off')
    expect((await runs())[0].status).toBe('handed_off')
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversation.id))
    expect(conv.status).toBe('pending')
  })

  it('allows only one active run per contact, even for concurrent starts', async () => {
    const { dispatch, runs } = await seed(MENU)
    await Promise.all([dispatch(text('order status', 'a')), dispatch(text('order status', 'b'))])
    expect((await runs()).filter((r) => r.status === 'active')).toHaveLength(1)
  })

  it('times out runs abandoned past the flow’s policy', async () => {
    const { dispatch, runs } = await seed(MENU)
    await dispatch(text('order status', 'm1'))
    expect(await sweepStaleFlowRuns()).toBe(0)
    await db.update(flowRuns).set({ lastAdvancedAt: new Date(Date.now() - 25 * 3_600_000) })
    expect(await sweepStaleFlowRuns()).toBe(1)
    expect((await runs())[0]).toMatchObject({ status: 'timed_out', endReason: 'stale_sweep' })
  })
})
