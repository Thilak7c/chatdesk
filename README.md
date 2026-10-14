# ChatDesk — CRM for WhatsApp

> Self-hostable CRM for WhatsApp® — shared inbox, contacts, sales
> pipelines, broadcasts, and no-code automations, running on your own
> server and database.

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![CI](https://github.com/Thilak7c/chatdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/Thilak7c/chatdesk/actions/workflows/ci.yml)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-pgvector-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org)

## Features

- **Shared inbox** on the official WhatsApp Business API — multiple
  agents working one number, per-conversation assignment, status, and
  notes.
- **Contacts + tags + custom fields**, CSV import, deduplication.
- **Sales pipelines** (Kanban) with deals linked to conversations.
- **Broadcasts** with Meta-approved templates, delivery + read
  tracking, per-recipient variable substitution.
- **No-code automations** — triggers on inbound messages, new
  contacts, keywords, or schedule; conditional branches, waits,
  tags, webhooks. Visual builder.
- **AI reply assistant** — bring your own OpenAI or Anthropic key
  (stored encrypted). One-click AI-drafted replies in the inbox, plus
  an optional auto-reply bot with a per-conversation cap and clean
  human handoff. Add a **knowledge base** (FAQs, policies, product
  docs) and it answers from your own content — hybrid retrieval
  (Postgres full-text, or semantic pgvector when an embeddings key is
  set).
- **Real-time dashboard** — response times, daily volume, pipeline
  value, cross-module activity feed.
- **Team accounts** — invite teammates by link, role-based access
  (owner / admin / agent / viewer), ownership transfer.
- **Account management** — email, password, avatar, global sign-out.
- **Public REST API** (`/api/v1`) with scoped, revocable API keys.
  See [docs/public-api.md](./docs/public-api.md).
- **MCP server** — drive the CRM from Claude, Cursor, and other AI
  assistants over the [Model Context Protocol](https://modelcontextprotocol.io).
  Read-only by default, opt-in writes. See [docs/mcp.md](./docs/mcp.md)
  (server in [`mcp-server/`](./mcp-server)).
- **Security** — token encryption (AES-256-GCM), account-scoped
  queries everywhere, database-backed sessions you can revoke,
  HMAC-verified webhooks, CSP, rate limiting.

## Quick start

```bash
git clone https://github.com/Thilak7c/chatdesk.git
cd chatdesk
npm install
cp .env.local.example .env.local   # set ENCRYPTION_KEY + Meta creds
docker compose -f docker-compose.dev.yml up -d   # Postgres, object storage, Mailpit
npm run db:migrate
npm run dev
```

Open <http://localhost:3000> and sign up — the first account you
create owns its workspace. Password-reset emails land in Mailpit at
<http://localhost:8025>.

## Deploying

ChatDesk runs as a long-lived Node.js process (`server.js` serves the
app and its WebSocket realtime channel on one port), so it needs a host
that keeps the process running and allows WebSockets — a VPS, a Docker
host, Railway, Render, Fly.io, or a managed Node.js host. Serverless
platforms are not supported.

- **Docker** (app + Postgres + object storage on one host): see
  [docs/docker.md](./docs/docker.md).
- **Any Node.js host:** provision PostgreSQL 14+ (with the `pgvector`
  extension available) and an S3-compatible bucket, set the variables
  from [`.env.local.example`](./.env.local.example), and use
  `npm run db:migrate && npm start` as the start command.

The WhatsApp webhook must be reachable over public HTTPS at
`https://<your-domain>/api/whatsapp/webhook`.

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Data** — PostgreSQL with pgvector, via Drizzle ORM (schema in
  [`src/db/schema.ts`](./src/db/schema.ts), migrations in
  [`drizzle/`](./drizzle)).
- **Auth** — email + password, database-backed sessions, SMTP for
  password resets.
- **Files** — any S3-compatible object store (SeaweedFS in the bundled
  Docker setup).
- **Realtime** — Socket.io on the same server, one room per account.
- **WhatsApp** — Meta Cloud API (official WhatsApp Business API).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Security issues: please
follow [`.github/SECURITY.md`](./.github/SECURITY.md) instead of
opening a public issue.

## License

[MIT](./LICENSE).
