import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  TagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import { and, asc, count, eq, gte, isNull, sql } from 'drizzle-orm'

import { db } from '@/db'
import {
  accounts,
  automationLogs,
  automationPendingExecutions,
  automations,
  automationSteps,
  contactCustomValues,
  contacts,
  contactTags,
  conversations,
  customFields,
  deals,
  profiles,
} from '@/db/schema'
import { toSnake } from '@/db/serialize'
import { notifyConversationAssigned } from '@/lib/conversations/assign'
import { publishConversation } from '@/lib/socket'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from '@/lib/contacts/tag-chain'
import { engineSendText, engineSendTemplate, engineSendInteractive } from './meta-send'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire. The per-automation user_id is read off each
   *  row when needed (log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), so before any step can touch the contact, verify it
    // actually belongs to this account. A foreign or forged id is
    // refused silently — callers are fire-and-forget, and a distinct
    // error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const owned = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, input.accountId)))
        .limit(1)
      if (owned.length === 0) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
    }

    const rows = await db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.accountId, input.accountId),
          eq(automations.triggerType, input.triggerType),
          eq(automations.isActive, true),
        ),
      )
    if (rows.length === 0) return

    for (const automation of rows.map(asAutomation)) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  const [row] = await db
    .select()
    .from(automations)
    .where(and(eq(automations.id, pending.automation_id), eq(automations.accountId, pending.account_id)))
    .limit(1)

  if (!row) {
    console.error('[automations] resume: missing automation', pending.automation_id)
    await markPending(pending.id, 'failed')
    return
  }

  try {
    await executeStepsFrom({
      automation: asAutomation(row),
      contactId: pending.contact_id,
      context: pending.context ?? {},
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

/** Drizzle row → the snake_case `Automation` shape the engine works in. */
function asAutomation(row: typeof automations.$inferSelect): Automation {
  return toSnake(row) as unknown as Automation
}

async function executeAutomation(automation: Automation, input: DispatchInput) {
  let log: { id: string } | undefined
  try {
    ;[log] = await db
    .insert(automationLogs)
    .values({
      automationId: automation.id,
      // Tenancy: matches automation.account_id.
      accountId: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      userId: automation.user_id,
      contactId: input.contactId ?? null,
      triggerEvent: input.triggerType,
      stepsExecuted: [],
      // Seeded pessimistically. The row is written BEFORE any step runs,
      // and every terminal path below overwrites it (`appendResults` at
      // the outermost scope, or `finalizeLog`). Seeding 'success' meant a
      // run that died mid-flight — the process frozen, the pod recycled —
      // left a permanent `status: 'success'` with `steps_executed: []`,
      // indistinguishable from an automation that genuinely had nothing
      // to do. 'failed' inverts that: the status only becomes success if
      // execution actually reached the end.
      status: 'failed',
    })
    .returning({ id: automationLogs.id })
  } catch (logErr) {
    console.error('[automations] cannot create log:', logErr)
    return
  }
  if (!log) return

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  // Atomic counter update in one UPDATE. A client-side
  // read-modify-write raced when the same automation fired for two
  // contacts simultaneously — both would read N and both write N+1.
  try {
    await db
      .update(automations)
      .set({
        executionCount: sql`${automations.executionCount} + 1`,
        lastExecutedAt: new Date(),
      })
      .where(eq(automations.id, automation.id))
  } catch (err) {
    console.error('[automations] increment counter failed:', err)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
}

async function executeStepsFrom(args: ExecuteArgs): Promise<void> {
  let steps: AutomationStep[]
  try {
    const rows = await db
      .select()
      .from(automationSteps)
      .where(
        and(
          eq(automationSteps.automationId, args.automation.id),
          gte(automationSteps.position, args.startPosition),
          args.parentStepId === null
            ? isNull(automationSteps.parentStepId)
            : and(
                eq(automationSteps.parentStepId, args.parentStepId),
                eq(automationSteps.branch, args.branch ?? 'yes'),
              ),
        ),
      )
      .orderBy(asc(automationSteps.position))
    steps = rows.map((r) => toSnake(r) as unknown as AutomationStep)
  } catch (stepsErr) {
    await finalizeLog(args.logId, 'failed', (stepsErr as Error).message)
    return
  }
  if (steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      await db.insert(automationPendingExecutions).values({
        automationId: args.automation.id,
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        contactId: args.contactId,
        logId: args.logId,
        parentStepId: args.parentStepId,
        branch: args.branch,
        nextStepPosition: step.position + 1,
        context: args.context,
        runAt: new Date(Date.now() + ms),
        status: 'pending',
      })
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      status = 'partial'
      await appendResults(args.logId, results, status, errorMessage)
      return
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage)
  }
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as SendButtonsStepConfig | SendListStepConfig
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`)
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      })
      return `interactive sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      const added = await addContactTagIfAbsent(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        tagId: cfg.tag_id,
      })
      if (!added) return `tag ${cfg.tag_id} already present`

      const depth = getTagChainDepth(args.context)
      if (depth >= MAX_TAG_CHAIN_DEPTH) {
        console.warn('[automations] tag_added chain depth limit reached', {
          automationId: args.automation.id,
          contactId: args.contactId,
          tagId: cfg.tag_id,
          depth,
        })
        return `tag ${cfg.tag_id} added; tag_added dispatch skipped at depth ${depth}`
      }

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'tag_added',
        contactId: args.contactId,
        context: {
          ...args.context,
          tag_id: cfg.tag_id,
          vars: {
            ...(args.context.vars ?? {}),
            _tag_chain_depth: depth + 1,
          },
        },
      })
      return `tag ${cfg.tag_id} added and tag_added dispatched`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db
        .delete(contactTags)
        .where(and(eq(contactTags.contactId, args.contactId), eq(contactTags.tagId, cfg.tag_id)))
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        // Pick any member of the account. The existing implementation
        // only ever returned the first member; preserving that shape
        // until a real round-robin algorithm replaces it.
        const [member] = await db
          .select({ userId: profiles.userId })
          .from(profiles)
          .where(eq(profiles.accountId, args.automation.account_id))
          .limit(1)
        agentId = member?.userId
      } else if (agentId) {
        // The configured agent must still be a member of this account.
        const [member] = await db
          .select({ userId: profiles.userId })
          .from(profiles)
          .where(and(eq(profiles.userId, agentId), eq(profiles.accountId, args.automation.account_id)))
          .limit(1)
        if (!member) return `agent ${agentId} is not a member of this account`
      }
      if (!agentId) return 'no agent resolved'
      const before = await db
        .select({ id: conversations.id, assignedAgentId: conversations.assignedAgentId })
        .from(conversations)
        .where(
          and(
            eq(conversations.accountId, args.automation.account_id),
            eq(conversations.contactId, args.contactId),
          ),
        )
      const updated = await db
        .update(conversations)
        .set({ assignedAgentId: agentId })
        .where(
          and(
            eq(conversations.accountId, args.automation.account_id),
            eq(conversations.contactId, args.contactId),
          ),
        )
        .returning()
      for (const conv of updated) {
        publishConversation(args.automation.account_id, 'UPDATE', conv)
        await notifyConversationAssigned(db, {
          accountId: args.automation.account_id,
          conversationId: conv.id,
          contactId: conv.contactId,
          newAssigneeId: agentId,
          previousAssigneeId: before.find((b) => b.id === conv.id)?.assignedAgentId ?? null,
          actorUserId: null,
        })
      }
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Confirm the field definition belongs to this account before
        // writing.
        const [field] = await db
          .select({ id: customFields.id })
          .from(customFields)
          .where(and(eq(customFields.id, customFieldId), eq(customFields.accountId, args.automation.account_id)))
          .limit(1)
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db
          .insert(contactCustomValues)
          .values({ contactId: args.contactId, customFieldId, value })
          .onConflictDoUpdate({
            target: [contactCustomValues.contactId, contactCustomValues.customFieldId],
            set: { value },
          })
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the write to the account so a future
      // caller that skips the entry-point ownership guard still cannot
      // write across tenants.
      await db
        .update(contacts)
        .set({ [cfg.field]: value })
        .where(and(eq(contacts.id, args.contactId), eq(contacts.accountId, args.automation.account_id)))
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule.
      const [acct] = await db
        .select({ defaultCurrency: accounts.defaultCurrency })
        .from(accounts)
        .where(eq(accounts.id, args.automation.account_id))
        .limit(1)
      await db.insert(deals).values({
        // Tenancy + audit, same split as automation_logs above.
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        pipelineId: cfg.pipeline_id,
        stageId: cfg.stage_id,
        contactId: args.contactId,
        title: interpolate(cfg.title, args),
        value: String(cfg.value ?? 0),
        currency: acct?.defaultCurrency ?? 'USD',
        status: 'open',
      })
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed')
      }
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      const closed = await db
        .update(conversations)
        .set({ status: 'closed' })
        .where(
          and(
            eq(conversations.accountId, args.automation.account_id),
            eq(conversations.contactId, args.contactId),
          ),
        )
        .returning()
      for (const conv of closed) publishConversation(args.automation.account_id, 'UPDATE', conv)
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const [data] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, args.automation.account_id),
        eq(conversations.contactId, args.contactId),
      ),
    )
    .orderBy(asc(conversations.createdAt))
    .limit(1)
  if (!data) {
    const prefix = args.triggerEvent === 'tag_added'
      ? 'tag_added automation cannot send'
      : 'cannot send'
    throw new Error(`${prefix}: contact has no existing conversation`)
  }
  return data.id
}

/** Letter, digit or underscore in any script — the "inside a word" test. */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/**
 * Whole-word keyword test, behind `match_type: 'word'` (a
 * one-letter keyword under `contains` fires on every message containing
 * that letter, e.g. "k" on "thanks").
 *
 * Deliberately NOT `\b`, which is defined against `[A-Za-z0-9_]` and so
 * breaks two cases that matter for WhatsApp traffic:
 *
 *   - A keyword carrying punctuation: `/\bhi!\b/` demands a word character
 *     after the "!", so it never matches "say hi!".
 *   - Any non-Latin script: every character of "안녕" is a non-word
 *     character to `\b`, so `/\b안녕\b/` matches nothing at all.
 *
 * Unicode-aware lookarounds handle both. Note this really is word-based:
 * it won't find "안녕" inside "안녕하세요", because a language that doesn't
 * delimit words with spaces has no word edge there. That's what `contains`
 * is for, and it stays the default.
 *
 * Exported for direct unit testing of the escaping / boundary edges.
 */
export function matchesWholeWord(
  text: string,
  keyword: string,
  caseSensitive = false,
): boolean {
  if (!keyword) return false
  // The keyword is account-supplied free text, so metacharacters have to
  // be literal — otherwise "(" is an unterminated group and RegExp throws.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`,
    caseSensitive ? 'u' : 'iu',
  )
  return pattern.test(text)
}

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) =>
        matchesWholeWord(text, raw, cfg.case_sensitive),
      )
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false
    }
    return cfg.reply_ids.includes(replyId)
  }

  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig
    const tagId = ctx?.tag_id
    return Boolean(tagId && cfg?.tag_id && cfg.tag_id === tagId)
  }

  return true
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      // contact_tags has no account_id column, so tenant scoping here
      // relies on the contact-ownership guard in runAutomationsForTrigger.
      const [row] = await db
        .select({ n: count() })
        .from(contactTags)
        .where(and(eq(contactTags.contactId, args.contactId), eq(contactTags.tagId, cfg.operand)))
      return (row?.n ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Only plain contact columns are comparable; scope to the account
      // so the condition can't become a cross-tenant read oracle.
      const FIELDS = ['name', 'email', 'phone', 'company'] as const
      type Field = (typeof FIELDS)[number]
      if (!FIELDS.includes(cfg.operand as Field)) return false
      const [row] = await db
        .select({ name: contacts.name, email: contacts.email, phone: contacts.phone, company: contacts.company })
        .from(contacts)
        .where(and(eq(contacts.id, args.contactId), eq(contacts.accountId, args.automation.account_id)))
        .limit(1)
      const v = row?.[cfg.operand as Field]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  // Append in SQL (jsonb ||) rather than read-modify-write, so nested
  // branch results can't overwrite each other.
  await db
    .update(automationLogs)
    .set({
      stepsExecuted: sql`${automationLogs.stepsExecuted} || ${JSON.stringify(newItems)}::jsonb`,
      // Only overwrite status on the outermost scope — nested branches pass null.
      ...(status !== null ? { status } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    })
    .where(eq(automationLogs.id, logId))
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await db.update(automationLogs).set({ status, errorMessage }).where(eq(automationLogs.id, logId))
}

async function markPending(id: string, status: 'done' | 'failed') {
  await db
    .update(automationPendingExecutions)
    .set({ status })
    .where(eq(automationPendingExecutions.id, id))
}
