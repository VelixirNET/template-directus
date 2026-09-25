// Starts Directus the way velixir runs apps.
//
// velixir injects PORT, DATABASE_URL and VELIXIR_APP_SLUG. Directus wants DB_CLIENT and friends,
// a SECRET that must stay the same across restarts, a PUBLIC_URL, and a first admin account.
// This file is the translation, plus the things that go wrong without it:
//
//   1. No database bound yet: serve a setup page rather than crash-looping.
//   2. TLS: velixir's DATABASE_URL says sslmode=require, which node-postgres (under Knex, under
//      Directus) reads as "verify against public CAs" and fails on the platform's own CA. Passing
//      the connection as discrete settings with DB_SSL__REJECT_UNAUTHORIZED=false is what works.
//   3. SECRET: Directus signs sessions and tokens with it. A new one every boot logs everyone out
//      on every restart, so it is generated once and kept in Postgres.
//   4. The first admin: created on the first boot with a generated password printed once to the
//      deploy log, rather than a default login anyone could guess.
//
// Anything you set yourself on the app's Environment tab wins.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client } = require('pg');

const PORT = Number(process.env.PORT || 8080);
const publicUrl = (process.env.PUBLIC_URL
  || (process.env.VELIXIR_APP_SLUG ? `https://${process.env.VELIXIR_APP_SLUG}.velixir.run` : `http://localhost:${PORT}`))
  .replace(/\/+$/, '');

// The Directus package only exports package.json, so find its CLI from there.
const DIRECTUS_CLI = path.join(path.dirname(require.resolve('directus/package.json')), 'cli.js');

// ─── Pages ──────────────────────────────────────────────────────────────────

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body, refreshSeconds) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:#0b0b10; color:#e8e8ef;
         font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  .wrap { max-width:38rem; margin:0 auto; padding:3rem 1.25rem 4rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; letter-spacing:-.02em; }
  .sub { color:#7a7a8c; font-size:.8125rem; margin:0 0 2rem; }
  code { background:#16161f; border:1px solid #26263a; border-radius:5px;
         padding:.1rem .35rem; color:#c7d2fe; font-size:.8125rem; overflow-wrap:anywhere; }
  ol { padding-left:1.25rem; margin:0 0 1.5rem; }
  li { margin-bottom:.9rem; }
  .note { color:#7a7a8c; font-size:.8125rem; }
  footer { color:#4b4b5c; font-size:.75rem; margin-top:2.5rem; text-align:center; }
  footer a { color:#7a7a8c; }
</style>
<div class="wrap">
  ${body}
  <footer>Directus, running on <a href="https://velixir.net">velixir</a></footer>
</div>
</html>`;
}

const SETUP_PAGE = page('Connect a database', `
  <h1>Connect a database</h1>
  <p class="sub">Directus keeps your content, users and settings in Postgres, and no database is bound to this app yet.</p>
  <ol>
    <li><strong>Create a managed Postgres</strong> from the Databases page, or run <code>velixir db create</code>.</li>
    <li><strong>Bind it to this app</strong> as <code>DATABASE_URL</code>: on the database's page under Bound apps,
      or <code>velixir db bind &lt;database-id&gt; --app &lt;app-id&gt;</code>.</li>
    <li><strong>Redeploy</strong> with the Redeploy button on the live release (Deploys tab).
      The admin login is printed in the deploy log on that first boot.</li>
  </ol>
  <p class="note">Deploying this template from the velixir gallery does all three for you.</p>`);

const startingPage = (detail) => page('Starting Directus', `
  <h1>Starting Directus</h1>
  <p class="sub">${escapeHtml(detail)} This page refreshes on its own.</p>`, 5);

// Serves while Directus is not answering yet. /healthz stays 200 so the platform does not
// restart a container that is doing exactly what it should.
function holdingServer(render) {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok (Directus not started yet)');
    }
    const { status, html } = render();
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  server.listen(PORT, '0.0.0.0');
  return server;
}

// ─── Database ───────────────────────────────────────────────────────────────

function parseDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  const mode = (url.searchParams.get('sslmode') || '').toLowerCase();
  return {
    host: url.hostname,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: mode !== '' && mode !== 'disable',
    verify: mode === 'verify-ca' || mode === 'verify-full',
  };
}

async function withDatabase(db, fn) {
  const client = new Client({
    host: db.host, port: Number(db.port), database: db.database, user: db.user, password: db.password,
    ssl: db.ssl ? { rejectUnauthorized: db.verify } : false,
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => {}); }
}

// Generated once, then read back forever. ON CONFLICT DO NOTHING makes two replicas booting at
// the same moment agree on one value instead of each inventing its own.
async function persistentSecret(client, name, make) {
  await client.query(`CREATE TABLE IF NOT EXISTS velixir_template_secrets (
    name TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await client.query(
    'INSERT INTO velixir_template_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
    [name, make()]);
  const { rows } = await client.query('SELECT value FROM velixir_template_secrets WHERE name = $1', [name]);
  return rows[0].value;
}

async function directusIsInstalled(client) {
  const { rows } = await client.query("SELECT to_regclass('public.directus_users') IS NOT NULL AS installed");
  return rows[0].installed === true;
}

// ─── Directus ───────────────────────────────────────────────────────────────

function directusEnv(db, secret, extra) {
  const env = { ...process.env };
  const setDefault = (key, value) => { if (env[key] === undefined || env[key] === '') env[key] = value; };

  setDefault('DB_CLIENT', 'pg');
  setDefault('DB_HOST', db.host);
  setDefault('DB_PORT', String(db.port));
  setDefault('DB_DATABASE', db.database);
  setDefault('DB_USER', db.user);
  setDefault('DB_PASSWORD', db.password);
  if (db.ssl) setDefault('DB_SSL__REJECT_UNAUTHORIZED', db.verify ? 'true' : 'false');
  // Small pool: several replicas multiply it, and a managed instance has a connection cap.
  setDefault('DB_POOL__MAX', '5');

  env.SECRET = env.SECRET || secret;
  setDefault('PUBLIC_URL', publicUrl);
  setDefault('HOST', '0.0.0.0');
  setDefault('PORT', String(PORT));
  setDefault('TELEMETRY', 'false');

  return { ...env, ...extra };
}

function runDirectus(args, env) {
  return spawn(process.execPath, [DIRECTUS_CLI, ...args], { env, stdio: 'inherit' });
}

function exitCode(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
}

function generatedPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function printAdminCredentials(email, password) {
  const line = '='.repeat(64);
  console.log([
    '', line,
    ' Directus admin account created. Sign in with:',
    '',
    `   URL:       ${publicUrl}/admin`,
    `   Email:     ${email}`,
    `   Password:  ${password}`,
    '',
    ' This is the only time the password is shown. Change it (and the',
    ' email) from your user profile once you are in.',
    line, '',
  ].join('\n'));
}

// ─── Signals ────────────────────────────────────────────────────────────────

// This process is PID 1 in its container, and PID 1 gets no default signal handling: without a
// handler a redeploy's SIGTERM would be ignored until the platform's grace period ran out. While
// Directus (or its bootstrap) runs, the signal goes to it; before that there is nothing to wait for.
let current = null;      // the Directus process running right now, if any
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    shuttingDown = true;
    if (current && current.exitCode === null) current.kill(signal);
    else process.exit(0);
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    console.log('DATABASE_URL is not set, so Directus is not started. Serving the setup page instead.\n'
      + 'Bind a managed Postgres to this app as DATABASE_URL, then redeploy.');
    holdingServer(() => ({ status: 200, html: SETUP_PAGE }));
    return;
  }

  const db = process.env.DATABASE_URL
    ? parseDatabaseUrl(process.env.DATABASE_URL)
    : { host: process.env.DB_HOST, port: process.env.DB_PORT || '5432', database: process.env.DB_DATABASE,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: false, verify: false };

  let status = 'Connecting to the database.';
  const holding = holdingServer(() => ({ status: 503, html: startingPage(status) }));

  // Retry rather than crash: a database that is briefly unreachable should delay Directus,
  // not put the container into a restart loop.
  let secret, installed;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ secret, installed } = await withDatabase(db, async (client) => ({
        secret: process.env.SECRET
          || await persistentSecret(client, 'directus_secret', () => crypto.randomBytes(32).toString('hex')),
        installed: await directusIsInstalled(client),
      })));
      break;
    } catch (err) {
      status = `Waiting for the database (${err.message}).`;
      if (attempt === 1 || attempt % 12 === 0) console.error(`database not reachable yet (attempt ${attempt}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // First boot: bootstrap installs the schema and creates the first admin from ADMIN_EMAIL /
  // ADMIN_PASSWORD. Later boots it only runs pending migrations, and ignores those variables.
  let credentials = null;
  const bootstrapEnv = {};
  if (!installed) {
    status = 'Installing Directus for the first time. This takes a minute.';
    const email = process.env.ADMIN_EMAIL || `admin@${new URL(publicUrl).hostname}`;
    const password = process.env.ADMIN_PASSWORD || generatedPassword();
    bootstrapEnv.ADMIN_EMAIL = email;
    bootstrapEnv.ADMIN_PASSWORD = password;
    if (!process.env.ADMIN_PASSWORD) credentials = { email, password };
  } else {
    status = 'Applying any database migrations.';
  }

  // Directus refuses uploads (and warns at every boot) when these do not exist. They are on the
  // container disk, so say loudly that local uploads are temporary unless storage is pointed
  // at a bucket.
  for (const dir of ['uploads', 'extensions']) fs.mkdirSync(path.join(process.cwd(), dir), { recursive: true });
  if ((process.env.STORAGE_LOCATIONS || 'local') === 'local') {
    console.warn('Uploads are stored on the container disk, which is wiped on every redeploy. '
      + 'Set STORAGE_LOCATIONS=s3 with the STORAGE_S3_* settings before uploading anything you want to keep.');
  }

  current = runDirectus(['bootstrap'], directusEnv(db, secret, bootstrapEnv));
  const code = await exitCode(current);
  // Printed before anything else can stop us: a redeploy arriving now must not lose the only
  // copy of the password (the next boot sees an installed database and never prints it).
  if (code === 0 && credentials) printAdminCredentials(credentials.email, credentials.password);
  if (shuttingDown) process.exit(0);
  if (code !== 0) {
    // Stay up with the reason rather than restart-looping through the same failure.
    console.error(`directus bootstrap failed (exit ${code}). See the output above.`);
    status = `Directus could not prepare the database (bootstrap exited with ${code}). Check the deploy log.`;
    return;
  }

  // The way back in when the password is lost. Bootstrap only reads ADMIN_EMAIL and
  // ADMIN_PASSWORD on an empty database, so on an installed one they reset that user's
  // password instead. Remove them once you are back in, or every boot resets it again.
  if (installed && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    current = runDirectus(['users', 'passwd', '--email', process.env.ADMIN_EMAIL, '--password', process.env.ADMIN_PASSWORD],
      directusEnv(db, secret, {}));
    const reset = await exitCode(current);
    if (shuttingDown) process.exit(0);
    console.log(reset === 0
      ? `Password reset for ${process.env.ADMIN_EMAIL} from ADMIN_PASSWORD. Remove ADMIN_EMAIL and ADMIN_PASSWORD once you have signed in.`
      : `Could not reset the password for ${process.env.ADMIN_EMAIL} (exit ${reset}). Check the email matches an existing user.`);
  }

  // Free the port for Directus. closeAllConnections drops idle keep-alive sockets too, which
  // would otherwise hold the listener open and make its bind fail with EADDRINUSE.
  await new Promise((resolve) => { holding.close(resolve); holding.closeAllConnections(); });

  const child = runDirectus(['start'], directusEnv(db, secret, {}));
  current = child;
  // Go down with Directus. A stop we asked for (a redeploy's SIGTERM, passed on above) is a clean
  // exit even though Directus itself dies from the signal: reporting it as a failure would make
  // every redeploy read as a crash. Anything else exits non-zero so the platform restarts it.
  child.on('exit', (exit, signal) => {
    if (shuttingDown) process.exit(0);
    console.error(`Directus stopped unexpectedly (${signal || `exit code ${exit}`}).`);
    process.exit(exit || 1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
