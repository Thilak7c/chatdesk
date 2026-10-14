import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { getObject, isMediaBucket, removeObject } from '@/lib/storage/object-store';

type Params = { params: Promise<{ bucket: string; path: string[] }> };

/**
 * GET /api/storage/<bucket>/<path> — public, like the old public
 * Storage buckets: Meta fetches outbound media from these URLs at send
 * time without credentials. Paths carry a timestamp + account id, so
 * they aren't enumerable.
 */
export async function GET(_request: Request, { params }: Params) {
  const { bucket, path } = await params;
  if (!isMediaBucket(bucket)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  try {
    const object = await getObject(bucket, path.join('/'));
    if (!object) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return new Response(Readable.toWeb(object.stream) as ReadableStream, {
      headers: {
        'Content-Type': object.contentType,
        'Content-Length': String(object.size),
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.error('[storage] read failed:', err);
    return NextResponse.json({ error: 'Failed to read object' }, { status: 500 });
  }
}

/**
 * DELETE /api/storage/<bucket>/<path> — remove an object the caller's
 * account owns (staged-but-unsent media). Only paths under the
 * caller's own `account-<id>/` folder can be deleted.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('agent');
    const { bucket, path } = await params;
    const joined = path.join('/');
    if (!isMediaBucket(bucket) || !joined.startsWith(`account-${ctx.accountId}/`)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    await removeObject(bucket, joined);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
