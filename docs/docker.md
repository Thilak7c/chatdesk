# Running with Docker

`docker-compose.yml` runs the whole thing on one host:

| Service   | Image                     | Role                                                        |
| --------- | ------------------------- | ----------------------------------------------------------- |
| `app`     | built from `Dockerfile`   | Next.js + Socket.io (`server.js`). Applies migrations on start. |
| `db`      | `pgvector/pgvector:pg16`  | PostgreSQL 16 with the pgvector extension.                  |
| `storage` | `chrislusf/seaweedfs`     | S3-compatible object storage for media.                     |

Only the app is published. Postgres and storage stay on Compose's
internal network — uploaded media is served through the app at
`/api/storage/...`, so the object store never needs to be public.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

   On top of the always-required `ENCRYPTION_KEY` and `META_APP_SECRET`,
   set the passwords for the bundled services:

   ```bash
   POSTGRES_PASSWORD=...
   STORAGE_SECRET_KEY=...
   ```

   `DATABASE_URL` and the `S3_*` settings in `.env.local` are ignored
   here — Compose points the app at its own `db` and `storage`.

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`). Put a
   TLS-terminating reverse proxy (Caddy, nginx, Traefik, ...) in front
   of it for production — the WhatsApp webhook requires HTTPS, and the
   proxy must pass WebSocket upgrades through for `/api/socket`.

> Save `.env.local` as UTF-8 (or plain ASCII). Docker cannot read a
> UTF-16 file, which is what some Windows editors write by default.

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container; Compose pins it to
> 3000 so the mapping and the healthcheck always match.

## Migrations

The container runs `node scripts/migrate.mjs` before starting the
server, so a new image applies any pending migrations automatically.
Already-applied migrations are skipped. To run them by hand:

```bash
docker compose --env-file .env.local exec app node scripts/migrate.mjs
```

## Backups

Everything stateful lives in two named volumes: `db-data` (Postgres)
and `storage-data` (media). Back up the database with:

```bash
docker compose --env-file .env.local exec db pg_dump -U chatdesk chatdesk > chatdesk.sql
```

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`.
- Everything else (`ENCRYPTION_KEY`, `META_APP_SECRET`, `SMTP_*`, …) is
  read at **runtime** from `.env.local` via `env_file` and is never
  baked into the image — safe to change with just a container restart.

## Using managed services instead

Drop the `db` / `storage` services and point the app at managed ones
(any PostgreSQL 14+ with `pgvector` available; any S3-compatible
bucket — AWS S3, Cloudflare R2, Backblaze B2, ...) by setting
`DATABASE_URL` and `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` /
`S3_BUCKET` in `.env.local` and removing the matching overrides from
the app's `environment:` block.

## Plain Docker (no Compose)

```bash
docker build --build-arg NEXT_PUBLIC_SITE_URL=https://crm.example.com -t chatdesk .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 chatdesk
```

`.env.local` then needs a reachable `DATABASE_URL` and `S3_*` settings.

## Several app replicas

Background jobs (automation waits, stale flow-run sweep, session
cleanup) run inside each app process. With more than one replica,
set `DISABLE_INTERNAL_CRON=true` on all but one, or on all of them and
drive `GET /api/automations/cron` and `GET /api/flows/cron` from an
external scheduler with `x-cron-secret: $AUTOMATION_CRON_SECRET`.
Realtime events are delivered per process, so replicas also need sticky
sessions plus a shared Socket.io adapter (e.g. Redis) — a single
replica is the supported setup today. The same goes for the rate
limiter, which is in-memory per process.
