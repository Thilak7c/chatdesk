import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { whatsappConfig } from '@/db/schema'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      )
    }

    // whatsapp_config is one per account, so a teammate fetching media
    // in the shared inbox uses the account's config.
    let accountId: string
    try {
      ;({ accountId } = await getCurrentAccount())
    } catch (err) {
      return toErrorResponse(err)
    }

    const [config] = await db
      .select({ accessToken: whatsappConfig.accessToken })
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, accountId))
      .limit(1)

    if (!config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.accessToken)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
