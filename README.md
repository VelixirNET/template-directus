# Directus

[![Deploy on velixir](https://velixir.net/img/deploy-on-velixir.svg)](https://velixir.net/new?template=directus)

[Directus](https://directus.io) is a headless CMS and data platform: it puts an admin UI and a
REST and GraphQL API on top of a SQL database you own.

[Deploy it on velixir](https://velixir.net/new?template=directus).

## What you get

Deploy it from the gallery and it comes up ready to sign in to:

- **A managed Postgres, created and connected for you.** Your content, users and settings live
  there, and the schema is installed on the first boot.
- **A first admin nobody can guess.** The admin account is created on the first boot with a
  generated password, printed once to the deploy log. No default login to change in a hurry.
- **Sessions that survive restarts.** Directus signs sessions with a `SECRET`. This one is
  generated once and kept in the database, so a redeploy does not sign everyone out.
- **The right public URL**, worked out from the app's address, so links and asset URLs point
  back at it.

## Signing in

Open the app's **Logs** after the first deploy and look for the box that says
**Directus admin account created**. It has the email and password. They are only printed once,
so change both from your user profile once you are in.

Lost the password? Set `ADMIN_EMAIL` (the admin's email) and `ADMIN_PASSWORD` on the app's
Environment tab and redeploy: on boot, that user's password is reset to `ADMIN_PASSWORD`. Remove
both once you are back in, or every redeploy resets it again.

## What this repo is

A thin wrapper, not a fork. `package.json` depends on the `directus` npm package, pinned to an
exact release, and `start.js` translates what velixir provides into what Directus reads:

| velixir provides | Directus gets |
| --- | --- |
| `PORT` | `PORT`, listening on `0.0.0.0` |
| `DATABASE_URL` | `DB_CLIENT=pg` and `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, with TLS |
| `VELIXIR_APP_SLUG` | `PUBLIC_URL` (override it for a custom domain) |
| nothing | a persistent `SECRET`, telemetry off |

It then runs `directus bootstrap`, which installs the schema on an empty database and applies
pending migrations on every later boot, and starts Directus. Anything you set yourself on the
Environment tab wins, so every
[Directus environment variable](https://directus.io/docs/configuration/general) still works as
documented.

Why the database is passed as separate settings rather than the URL: velixir's `DATABASE_URL`
asks for TLS with `sslmode=require`, and the Postgres driver underneath Directus reads that as
"verify the certificate against public CAs", which fails on the platform's own CA. Separate
settings with `DB_SSL__REJECT_UNAUTHORIZED=false` give an encrypted connection that works.

To upgrade Directus, change the version in `package.json`, run `npm install` to refresh the
lockfile, and deploy. Read the release notes first.

## Things to know before you rely on this

**Uploaded files need object storage.** By default Directus writes uploads to local disk, and a
container's disk does not survive a redeploy. Configure an S3-compatible storage location
(`STORAGE_LOCATIONS=s3` with the `STORAGE_S3_*` settings, for example on Cloudflare R2 or any S3
provider) before you upload anything you care about.

**Email goes through an API, not SMTP.** Outbound SMTP is blocked on velixir. Set
`EMAIL_TRANSPORT` to `mailgun`, `sendgrid` or `ses` with the matching settings so password resets
and invitations can be sent.

**It wants at least 512 MB.** The create form will not offer smaller plans, which also rules out
the Free plan.

## On your own domain

Add the domain to the app, then set `PUBLIC_URL` to `https://your.domain` and redeploy.

## Running it locally

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/directus npm start
```

Then open http://localhost:8080/admin and sign in with the details printed on the first boot.

## Upstream

Directus 12 is licensed under the
[Monospace Sustainable Core License](https://github.com/directus/directus/blob/main/license)
(MSCL-1.0), which is source-available, not OSI open source. It permits any use except offering
Directus to others as a competing commercial service. Read it before commercial use. This wrapper
is MIT; the licence that matters is upstream's.

- Docs: https://directus.io/docs
- Source: https://github.com/directus/directus
