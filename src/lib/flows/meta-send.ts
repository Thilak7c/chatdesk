import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { engineSend, type EngineSendResult } from '@/lib/whatsapp/engine-send'

// ------------------------------------------------------------
// Flows-side Meta senders (text, media, interactive). The shared
// lookup / retry / persistence lives in engineSend; each sender here
// only says what to send and what to record.
// ------------------------------------------------------------

interface EngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the flow — kept for logs. Not consulted for
   *  tenancy. */
  userId: string
  conversationId: string
  contactId: string
}

interface SendTextEngineArgs extends EngineArgs {
  text: string
  /** Marks the persisted message row `ai_generated = true` so the inbox
   *  badges it as an AI reply. Only the auto-reply bot sets this;
   *  deterministic Flow/automation sends leave it false. */
  aiGenerated?: boolean
}

/**
 * Send a plain-text WhatsApp message from the Flows engine (the
 * runner's `send_message` / `collect_input` nodes, and AI auto-reply).
 */
export async function engineSendText(args: SendTextEngineArgs): Promise<EngineSendResult> {
  return engineSend(
    args,
    (m) => sendTextMessage({ ...m, text: args.text }),
    { contentType: 'text', contentText: args.text, aiGenerated: args.aiGenerated },
  )
}

interface SendMediaEngineArgs extends EngineArgs {
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine (the
 * runner's `send_media` node). Persisted with `content_type` matching
 * the media kind so the inbox renders the right preview.
 */
export async function engineSendMedia(args: SendMediaEngineArgs): Promise<EngineSendResult> {
  return engineSend(
    args,
    (m) =>
      sendMediaMessage({
        ...m,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
      }),
    {
      contentType: args.kind,
      contentText: args.caption ?? null,
      preview: args.caption?.trim() || `[${args.kind}]`,
    },
  )
}

interface SendInteractiveButtonsEngineArgs extends EngineArgs {
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs extends EngineArgs {
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button message. The structured payload is
 * persisted so the inbox thread re-renders the buttons the bot sent;
 * `interactive_reply_id` stays empty — it's for the customer's tap,
 * filled in by the webhook.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<EngineSendResult> {
  const payload: InteractiveMessagePayload = {
    kind: 'buttons',
    body: args.bodyText,
    header: args.headerText,
    footer: args.footerText,
    buttons: args.buttons,
  }
  return engineSend(
    args,
    (m) =>
      sendInteractiveButtons({
        ...m,
        bodyText: args.bodyText,
        buttons: args.buttons,
        headerText: args.headerText,
        footerText: args.footerText,
      }),
    { contentType: 'interactive', contentText: args.bodyText, interactivePayload: payload },
  )
}

/**
 * Send an interactive-list message. Used when the flow needs more
 * than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<EngineSendResult> {
  const payload: InteractiveMessagePayload = {
    kind: 'list',
    body: args.bodyText,
    header: args.headerText,
    footer: args.footerText,
    button_label: args.buttonLabel,
    sections: args.sections,
  }
  return engineSend(
    args,
    (m) =>
      sendInteractiveList({
        ...m,
        bodyText: args.bodyText,
        buttonLabel: args.buttonLabel,
        sections: args.sections,
        headerText: args.headerText,
        footerText: args.footerText,
      }),
    { contentType: 'interactive', contentText: args.bodyText, interactivePayload: payload },
  )
}
