import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendText as flowsSendText,
} from '@/lib/flows/meta-send'
import { db } from '@/db'
import { engineSend, type EngineSendResult } from '@/lib/whatsapp/engine-send'
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body'

// ------------------------------------------------------------
// Automation-side Meta senders. Same send base as the Flows engine
// (src/lib/whatsapp/engine-send.ts): account-scoped lookups,
// phone-variant retry, persistence as sender_type 'bot'.
// ------------------------------------------------------------

interface EngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation — kept for logs. Not consulted
   *  for tenancy. */
  userId: string
  conversationId: string
  contactId: string
}

interface SendTextArgs extends EngineArgs {
  text: string
}

interface SendTemplateArgs extends EngineArgs {
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<EngineSendResult> {
  return flowsSendText(args)
}

export async function engineSendTemplate(args: SendTemplateArgs): Promise<EngineSendResult> {
  // Local template row — read for the body we persist, not for the
  // Meta payload. A missing row is fine: the send still goes out, we
  // just can't reconstruct the text the customer saw.
  const { row: templateRow } = await resolveTemplateRow(
    db,
    args.accountId,
    args.templateName,
    args.language,
  )
  // Templates persist the substituted body, same as the manual and
  // public-API send paths.
  const contentText = templateContentText(templateRow, args.params ?? [])

  return engineSend(
    args,
    (m) =>
      sendTemplateMessage({
        ...m,
        templateName: args.templateName,
        language: args.language,
        params: args.params,
      }),
    {
      contentType: 'template',
      contentText,
      templateName: args.templateName,
      preview: contentText ?? `[template:${args.templateName}]`,
    },
  )
}

interface SendInteractiveArgs extends EngineArgs {
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine via the Flows interactive senders, so both
 * engines share one implementation.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<EngineSendResult> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}
