// ============================================================
// GET  /api/v1/contacts  — list contacts (scope: contacts:read)
// POST /api/v1/contacts  — create a contact  (scope: contacts:write)
//
// List is keyset-paginated (see src/lib/api/v1/pagination.ts) and
// supports `?search=` (name/phone/email) and `?tag=<tagId>` filters.
// Create is find-or-create by phone: an existing match returns 200
// with `created: false`; a new row returns 201 with `created: true`.
// ============================================================

import { db } from '@/db';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import {
  findOrCreateContact,
  setContactTags,
  getContactById,
  listContacts,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const search = (url.searchParams.get('search') ?? '').trim().slice(0, 200);
    const tag = url.searchParams.get('tag');
    if (tag && !UUID_RE.test(tag)) {
      return fail('bad_request', "'tag' must be a tag id", 400);
    }

    const rows = await listContacts(db, ctx.accountId, {
      limit,
      cursor,
      search: search || null,
      tagId: tag,
    });
    const { items, nextCursor } = buildPage(rows, limit);
    return okList(items, nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) {
      return fail('bad_request', "'phone' is required", 400);
    }

    const auditUserId = await resolveAuditUserId(db, ctx.accountId);

    const { id, created } = await findOrCreateContact(db, ctx.accountId, auditUserId, {
      phone,
      name: typeof body.name === 'string' ? body.name : undefined,
      email: typeof body.email === 'string' ? body.email : undefined,
      company: typeof body.company === 'string' ? body.company : undefined,
    });

    if (Array.isArray(body.tags)) {
      await setContactTags(
        db,
        ctx.accountId,
        auditUserId,
        id,
        body.tags.filter((t): t is string => typeof t === 'string')
      );
    }

    const contact = await getContactById(db, ctx.accountId, id);
    return ok(contact, created ? 201 : 200);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
