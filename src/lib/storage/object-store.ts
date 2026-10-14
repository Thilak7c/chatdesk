// ============================================================
// Object storage on any S3-compatible service (SeaweedFS in the bundled
// docker-compose; AWS S3, Cloudflare R2, Backblaze B2, ... elsewhere).
//
// One physical bucket (S3_BUCKET) holds every logical "media bucket"
// as a key prefix: `<media-bucket>/account-<id>/<file>`. Objects are
// written only by the server (uploads go through /api/storage/upload)
// and read back through the public /api/storage/<bucket>/<path> route,
// so the S3 service itself never needs to be exposed to the internet.
//
// Env:
//   S3_ENDPOINT    e.g. http://storage:8333 or https://s3.eu-west-1.amazonaws.com
//   S3_REGION      default us-east-1
//   S3_ACCESS_KEY / S3_SECRET_KEY
//   S3_BUCKET      default "chatdesk" (created on first use if missing)
// ============================================================

import { Client } from 'minio';
import type { Readable } from 'node:stream';

/** Per-media-bucket policy — carried over from the old Storage buckets. */
export const MEDIA_BUCKETS = {
  'chat-media': {
    maxBytes: 16 * 1024 * 1024,
    mimeTypes: [
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'video/mp4', 'video/3gpp', 'video/3gp', 'video/quicktime',
      'application/pdf', 'application/vnd.ms-powerpoint', 'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'audio/ogg', 'audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/amr', 'audio/opus',
    ],
  },
  'flow-media': {
    maxBytes: 16 * 1024 * 1024,
    mimeTypes: [
      'image/png', 'image/jpeg', 'image/webp',
      'video/mp4', 'video/3gpp',
      'application/pdf', 'application/vnd.ms-powerpoint', 'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
    ],
  },
  avatars: {
    maxBytes: 2 * 1024 * 1024,
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
} as const;

export type MediaBucket = keyof typeof MEDIA_BUCKETS;

export function isMediaBucket(name: string): name is MediaBucket {
  return Object.prototype.hasOwnProperty.call(MEDIA_BUCKETS, name);
}

export class StorageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageRejectedError';
  }
}

/** Throws StorageRejectedError when the bucket's MIME / size policy refuses the object. */
export function assertAllowed(bucket: MediaBucket, contentType: string, size: number): void {
  const policy = MEDIA_BUCKETS[bucket];
  const mime = contentType.split(';')[0].trim().toLowerCase();
  if (!(policy.mimeTypes as readonly string[]).includes(mime)) {
    throw new StorageRejectedError(`File type ${mime || 'unknown'} is not allowed here`);
  }
  if (size > policy.maxBytes) {
    throw new StorageRejectedError(
      `File is too large (max ${Math.round(policy.maxBytes / 1024 / 1024)} MB)`,
    );
  }
}

let client: Client | null = null;
let bucketReady: Promise<void> | null = null;

function physicalBucket(): string {
  return process.env.S3_BUCKET || 'chatdesk';
}

function getClient(): Client {
  if (client) return client;
  const endpoint = process.env.S3_ENDPOINT;
  if (!endpoint) throw new Error('S3_ENDPOINT is not configured');
  const url = new URL(endpoint);
  client = new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    useSSL: url.protocol === 'https:',
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
    region: process.env.S3_REGION || 'us-east-1',
    pathStyle: true,
  });
  return client;
}

async function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const c = getClient();
      const name = physicalBucket();
      if (!(await c.bucketExists(name))) {
        await c.makeBucket(name, process.env.S3_REGION || 'us-east-1');
      }
    })().catch((err) => {
      bucketReady = null; // retry on the next call
      throw err;
    });
  }
  return bucketReady;
}

function objectKey(bucket: MediaBucket, path: string): string {
  // Paths are built by buildMediaPath; refuse anything that tries to
  // climb out of its prefix.
  if (path.includes('..') || path.startsWith('/')) {
    throw new StorageRejectedError('Invalid object path');
  }
  return `${bucket}/${path}`;
}

/** Write an object (overwrites an existing one at the same path). */
export async function putObject(
  bucket: MediaBucket,
  path: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  assertAllowed(bucket, contentType, body.byteLength);
  await ensureBucket();
  await getClient().putObject(physicalBucket(), objectKey(bucket, path), body, body.byteLength, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=3600',
  });
}

export interface StoredObject {
  stream: Readable;
  contentType: string;
  size: number;
}

/** Read an object, or null if it doesn't exist. */
export async function getObject(bucket: MediaBucket, path: string): Promise<StoredObject | null> {
  await ensureBucket();
  const c = getClient();
  const key = objectKey(bucket, path);
  try {
    const stat = await c.statObject(physicalBucket(), key);
    const stream = await c.getObject(physicalBucket(), key);
    return {
      stream,
      contentType: String(stat.metaData?.['content-type'] ?? 'application/octet-stream'),
      size: stat.size,
    };
  } catch (err) {
    if ((err as { code?: string }).code === 'NotFound' || (err as { code?: string }).code === 'NoSuchKey') {
      return null;
    }
    throw err;
  }
}

export async function removeObject(bucket: MediaBucket, path: string): Promise<void> {
  await ensureBucket();
  await getClient().removeObject(physicalBucket(), objectKey(bucket, path));
}

/**
 * The URL an object is served at. Absolute when `baseUrl` is given —
 * Meta fetches media by URL at send time, so anything handed to the
 * WhatsApp API must be absolute and publicly reachable.
 */
export function publicObjectUrl(bucket: MediaBucket, path: string, baseUrl = ''): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl.replace(/\/+$/, '')}/api/storage/${bucket}/${encoded}`;
}
