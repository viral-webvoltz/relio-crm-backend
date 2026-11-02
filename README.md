# Relio CRM – Backend

REST API for a multi-tenant CRM, built with Express 5, TypeScript, PostgreSQL and Drizzle ORM.

## What it does

Contacts, companies, leads, deals and sales pipelines, tasks and activities, quotes, invoices, orders and subscriptions, support tickets with SLAs, email campaigns, workflows, goals, documents, a customer portal, webhooks, API keys, audit logs, trash with retention, and reports. Every organization's data is isolated, and permissions come from roles on the server.

- **Auth:** cookie sessions (`sid`), or `Authorization: Bearer <session token>`. Two-factor login is supported. Scripts can use API keys that start with `crm_`.
- **Mail:** outgoing email over SMTP or connected Gmail accounts. Replies come back through an inbound email hook.
- **API docs:** an OpenAPI document is served under `/api/v1/docs` and generated into `openapi.json`.

## Requirements

- Node.js 22
- PostgreSQL

## Getting started

```bash
npm install
cp .env.example .env      # then fill in the values below
npm run db:migrate        # create the tables
npm run db:sync-permissions
npm run dev               # http://localhost:4000
```

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | At least 32 random characters |
| `PORT` | no | Default `4000` |
| `NODE_ENV` | no | `development`, `test` or `production`. In production the session cookie is `SameSite=None; Secure` |
| `CORS_ORIGIN` | no | The exact URL of the frontend, no trailing slash. Also used by the CSRF origin check |
| `APP_URL` | no | Public URL of the web app, used for links in emails |
| `API_URL` | no | Public URL of this API, used for tracking and unsubscribe links |
| `TRUST_PROXY` | no | Number of reverse proxies in front of the API. Set to `1` behind one proxy so rate limits use the real client IP |
| `SMTP_URL`, `MAIL_FROM` | no | Outgoing email. Both are needed, otherwise email features are off |
| `INBOUND_EMAIL_SECRET` | no | Shared secret for `POST /api/v1/inbound/email`. If unset, that endpoint does not exist |
| `INBOUND_EMAIL_ADDRESS` | no | Address that inbound replies are sent to |
| `RATE_LIMIT_USER_PER_MIN`, `RATE_LIMIT_ORG_PER_MIN` | no | Per-minute limits. `0` disables |
| `RATE_LIMIT_STORE` | no | `database` (shared by all instances) or `memory` |
| `TRASH_RETENTION_DAYS` | no | Days a deleted record stays in the trash. Default `30` |
| `TEST_DATABASE_URL` | tests | Database used by the integration tests |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with auto-reload |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run typecheck` | Type-check without building |
| `npm run lint` / `npm run format` | oxlint and Prettier |
| `npm test` | Unit tests (Vitest) |
| `npm run test:integration` | Integration tests, need `TEST_DATABASE_URL` |
| `npm run db:generate` | Create a migration from schema changes |
| `npm run db:migrate` | Apply migrations |
| `npm run db:sync-permissions` | Sync the permission list to the database |
| `npm run db:grant-defaults` | Grant the default permissions to roles |
| `npm run docs:openapi` | Regenerate `openapi.json` |

## Project layout

```
src/
  app.ts, server.ts   Express setup and entry point
  config/             Environment validation
  database/           Drizzle schema and migrations
  middleware/         Auth, CSRF origin check, rate limits, validation
  modules/<name>/     One folder per feature: routes, controller, service, repository, validation
  routes/             Mounts every module under /api/v1
  shared/             Errors, logging and response helpers
```

New features follow the same pattern: routes call a controller, the controller calls a service, and the service calls a repository.

## Deployment

A `Dockerfile` and `docker-compose.prod.yml` / `docker-compose.stag.yml` are included. In production, set `NODE_ENV=production`, `CORS_ORIGIN` to the frontend's exact URL, `TRUST_PROXY` if behind a proxy, and run `npm run db:migrate` on each release.

When the frontend is on a different site from the API (for example `*.vercel.app` and your own domain), the session cookie is `SameSite=None`. The frontend can also send the token from login as a Bearer header, which avoids third-party cookie blocking.
