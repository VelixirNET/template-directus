# Directus

[![Deploy on velixir](https://velixir.net/img/deploy-on-velixir.svg)](https://velixir.net/new?template=directus)

[Directus](https://directus.io) is a headless CMS and data platform: it puts an
admin UI and a REST/GraphQL API on top of a SQL database you own.

[Deploy it on velixir](https://velixir.net/new?template=directus).

## What this repo is

A thin wrapper, not a fork. `package.json` depends on the `directus` npm package and the
start script runs it. Upgrading is a version bump, and there is no vendored upstream to keep
in sync.

```json
"scripts": { "start": "directus bootstrap && directus start" }
```

`bootstrap` creates the schema and the first admin on an empty database, then does nothing on
subsequent boots, so the same command is safe on every deploy.

## Setting it up on velixir

Directus needs a database and a few secrets. It will not start without them.

1. **Create a managed Postgres** and bind it to the app on the **Databases** tab. That
   injects `DATABASE_URL`.
2. **Set these on the app's Environment tab:**

   | Variable | Value |
   | --- | --- |
   | `DB_CLIENT` | `pg` |
   | `DB_CONNECTION_STRING` | `${DATABASE_URL}` (paste the same value) |
   | `DB_SSL__REJECT_UNAUTHORIZED` | `false` |
   | `KEY` | a random string |
   | `SECRET` | a different random string |
   | `ADMIN_EMAIL` | your email |
   | `ADMIN_PASSWORD` | a strong password |
   | `PUBLIC_URL` | `https://your-app.velixir.run` |

   Generate the two secrets with something like `openssl rand -hex 32`. Treat them as
   credentials: rotating `SECRET` invalidates every session.

3. Deploy. The first boot runs migrations and creates the admin user.

`DB_SSL__REJECT_UNAUTHORIZED=false` is needed because velixir's managed Postgres presents a
certificate from the platform's own CA rather than a public one. The connection is still
encrypted.

## Two things to know before you rely on this

**Uploaded files need object storage.** By default Directus writes uploads to local disk,
and a container's disk does not survive a redeploy. Configure the S3 storage driver
(`STORAGE_LOCATIONS`, `STORAGE_S3_*`) before you upload anything you care about.

**Do not run it on a scale-to-zero plan.** Directus is slow to cold-start and holds database
connections; an app that sleeps when idle will feel broken. Use a plan that stays warm.

## Running it locally

```bash
npm install
DB_CLIENT=pg DB_CONNECTION_STRING=postgres://... KEY=dev SECRET=dev npm start
```

## Upstream

Directus is licensed under [BSL 1.1](https://github.com/directus/directus/blob/main/license).
Read it before commercial use: it is source-available, not OSI open source. This wrapper is
MIT; the licence that matters is upstream's.

- Docs: https://docs.directus.io
- Source: https://github.com/directus/directus
