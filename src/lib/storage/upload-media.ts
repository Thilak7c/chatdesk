/**
 * Shared media-upload helpers. Objects live under an account-scoped
 * path:
 *
 *   <bucket>/account-<account_id>/<timestamp>-<basename>.<ext>
 *
 * The server builds the path (POST /api/storage/upload) from the
 * caller's session, and DELETE only accepts paths under the caller's
 * own `account-<id>/` folder. Browser code (Flows builder, inbox
 * composer, template manager) goes through the helpers below.
 */

/** 16 MB — the chat-media / flow-media limit (see object-store.ts). */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Per-kind upload ceilings that mirror Meta's WhatsApp Cloud API caps so
 * a file that the bucket would accept (≤16 MB) but Meta would reject is
 * caught client-side BEFORE upload — otherwise it lands in storage as an
 * orphan and the send fails with a confusing 400. Images are Meta's
 * tightest cap at 5 MB; documents are held at the 16 MB bucket limit
 * (Meta allows 100 MB, but the bucket — and shared-hosting upload UX —
 * caps lower).
 */
export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
} as const;

/**
 * Build the account-scoped object path for an upload. Pure + exported so
 * it can be unit-tested and shared by server code.
 *
 * - `basename` is stripped of its extension, lower-cased non-safe chars
 *   are collapsed to `_`, and it's capped at 40 chars (falls back to
 *   "file" when empty).
 * - The timestamp + the original name keep collisions between two
 *   concurrent uploads astronomically unlikely.
 *
 * `now = null` omits the timestamp prefix entirely. That's for callers
 * whose name is already unique AND who need the path to be *stable*
 * across repeated calls — the inbound mirror (`@/lib/whatsapp/
 * mirror-inbound-media`) keys on Meta's media id so a redelivered
 * webhook rewrites one object instead of orphaning a second copy.
 *
 * `subfolder` inserts one level below `account-<id>`. Ownership checks
 * only look at the FIRST path segment, so nesting below it is free.
 */
export function buildMediaPath(
  accountId: string,
  fileName: string,
  now: number | null = Date.now(),
  subfolder?: string,
): string {
  // Only treat the trailing segment as an extension when there's a real
  // one — a bare name like "README" has no extension and falls back to
  // "bin" rather than becoming "readme".
  const hasExt = /\.[^.]+$/.test(fileName);
  const ext = hasExt ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const safeBase =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 40) || "file";
  const dir = subfolder
    ? `account-${accountId}/${subfolder}`
    : `account-${accountId}`;
  const stamp = now === null ? "" : `${now}-`;
  return `${dir}/${stamp}${safeBase}.${ext}`;
}

export interface UploadAccountMediaResult {
  /** Public URL Meta can fetch at send time. */
  publicUrl: string;
  /** Storage object path (account-scoped). */
  path: string;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return (data && typeof data.error === "string" && data.error) || fallback;
}

/**
 * Upload a file to an account-scoped media bucket and return its public
 * URL. Throws with a user-facing message on auth / validation / upload
 * failure — callers surface it via a toast.
 *
 * Size validation is the caller's responsibility (limits can differ per
 * feature); `MEDIA_MAX_BYTES` is exported for the common case. The
 * server re-checks the bucket's own limits.
 */
export async function uploadAccountMedia(
  bucket: string,
  file: File,
): Promise<UploadAccountMediaResult> {
  const form = new FormData();
  form.append("bucket", bucket);
  form.append("file", file);
  const res = await fetch("/api/storage/upload", { method: "POST", body: form });
  if (res.status === 401) throw new Error("Not signed in.");
  if (!res.ok) throw new Error(await errorMessage(res, "Upload failed."));
  return (await res.json()) as UploadAccountMediaResult;
}

/**
 * Delete a previously-uploaded object. Used to GC media that was staged
 * (uploaded) but never sent — a cancelled draft or a failed Meta send —
 * so abandoned attachments don't accumulate. The server only deletes
 * objects under the caller's own account folder.
 *
 * Best-effort: callers fire-and-forget and swallow errors (a missed
 * delete is a storage nit, not something to surface to the user).
 */
export async function deleteAccountMedia(
  bucket: string,
  path: string,
): Promise<void> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`/api/storage/${encodeURIComponent(bucket)}/${encoded}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await errorMessage(res, "Delete failed."));
}
