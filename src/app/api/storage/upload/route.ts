import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { buildMediaPath } from '@/lib/storage/upload-media';
import {
  isMediaBucket,
  publicObjectUrl,
  putObject,
  StorageRejectedError,
} from '@/lib/storage/object-store';
import { siteUrlFrom } from '@/lib/site-url';

/**
 * POST /api/storage/upload — multipart form with `bucket` and `file`.
 * Stores the file under the caller's `account-<id>/` folder and returns
 * `{ publicUrl, path }`. The bucket's MIME/size policy is enforced in
 * object-store.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ error: 'Expected multipart form data' }, { status: 400 });
    }
    const bucket = String(form.get('bucket') ?? '');
    const file = form.get('file');
    if (!isMediaBucket(bucket)) {
      return NextResponse.json({ error: 'Unknown bucket' }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }

    const path = buildMediaPath(ctx.accountId, file.name);
    const body = Buffer.from(await file.arrayBuffer());
    await putObject(bucket, path, body, file.type || 'application/octet-stream');

    return NextResponse.json({
      path,
      publicUrl: publicObjectUrl(bucket, path, siteUrlFrom(request)),
    });
  } catch (err) {
    if (err instanceof StorageRejectedError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
