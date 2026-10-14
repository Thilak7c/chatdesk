# Changelog

User-visible changes in ChatDesk. Self-hosters: when pulling an update,
check this file for upgrade notes. Database migrations are applied with
`npm run db:migrate` (the Docker image runs it on every start).

Versions follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] — 2026-10-14

First release.

### Added

- **Shared inbox** on the WhatsApp Business Cloud API — assignment,
  status, notes, quick replies, reactions, replies, media and
  interactive messages.
- **Contacts** with tags, custom fields, CSV import and deduplication.
- **Sales pipelines** (Kanban) with deals linked to conversations.
- **Broadcasts** with Meta-approved templates, delivery and read
  tracking, and resume/retry of interrupted sends.
- **Automations and Flows** — visual, no-code builders triggered by
  inbound messages, new contacts, keywords or schedules.
- **AI reply assistant** — bring-your-own OpenAI or Anthropic key,
  drafted replies, optional auto-reply with human handoff, and a
  knowledge base with full-text and pgvector retrieval.
- **Team accounts** with owner / admin / agent / viewer roles,
  invitations and ownership transfer.
- **Public REST API** (`/api/v1`) with scoped API keys and signed
  outbound webhooks, plus an MCP server in `mcp-server/`.
- **Self-contained backend** — PostgreSQL (Drizzle ORM), built-in
  email + password auth with database-backed sessions, any
  S3-compatible storage, Socket.io realtime and in-process background
  jobs. Ships with `docker-compose.yml` for a one-host deployment.
