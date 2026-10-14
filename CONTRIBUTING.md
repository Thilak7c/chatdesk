# Contributing to ChatDesk

## Local setup

```bash
git clone https://github.com/Thilak7c/chatdesk.git
cd chatdesk

cp .env.local.example .env.local   # set ENCRYPTION_KEY + Meta creds
npm install
docker compose -f docker-compose.dev.yml up -d   # Postgres, storage, Mailpit
npm run db:migrate
npm run dev
```

Schema changes: edit `src/db/schema.ts`, then `npm run db:generate`
and commit the new file under `drizzle/` (CI fails if they drift).

Tests: `npm test` runs everything. The database suites
(`*.db.test.ts`) need a throwaway Postgres in `TEST_DATABASE_URL` —
it is wiped on every run — and are skipped without it:

```bash
docker compose -f docker-compose.dev.yml exec db createdb -U chatdesk chatdesk_test
TEST_DATABASE_URL=postgresql://chatdesk:chatdesk@localhost:5432/chatdesk_test npm test
```

More setup and deployment notes live in [`docs/`](./docs).

## Reporting bugs

File a [bug report](https://github.com/Thilak7c/chatdesk/issues/new?template=bug_report.yml).
Including the commit SHA, the runtime (Docker / Node host / local), and
logs will get to a fix fastest.

## Reporting security issues

**Do not file security issues publicly.** Follow the private flow in
[SECURITY.md](./.github/SECURITY.md).

## Pull requests

- Branch off the latest `main`.
- Run `npm run typecheck`, `npm run lint` and `npm test` locally first.
- Fill in the PR template, especially the **Test plan**.
- One logical change per PR.
- Commit-message first line is imperative + terse; the body explains
  the *why*, the diff shows the *what*.

## Dev-loop reference

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 3000. |
| `npm run build` | Production build. Next also runs its own typecheck here. |
| `npm run typecheck` | `tsc --noEmit`. Fast TS-only pass. |
| `npm run lint` | ESLint. |
| `npm test` | Vitest (database suites need `TEST_DATABASE_URL`). |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts`. |
| `npm run db:migrate` | Apply pending migrations. |
| `npm run format` | Prettier write. |
| `npm run format:check` | Prettier in check-only mode. |

## Licensing

ChatDesk is MIT ([`LICENSE`](./LICENSE)). Contributions are accepted
under the same license.
