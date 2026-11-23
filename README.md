# RedditPZ challenge features (Cloudflare Worker)

Challenge progress, buddy finder and Strava power overlay for RedditPZ riders, moving from the
Google Sheets + Apps Script prototype to Cloudflare. Built to the conventions of
sourdoughrides.com's `worker/` (Hono, Kysely over D1, vitest in the Workers runtime) so it can be
offered there as merge requests later.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Entry point; mounts the API at `/rpz/api` |
| `src/rpz/api.ts` | The JSON API (same request/response shape as the Apps Script `doPost`) |
| `src/rpz/db.ts` | Table types; `batch()` runs all of a request's queries in one D1 round trip |
| `src/rpz/auth.ts` | Google sign-in token check (Google's public keys, cached) |
| `src/rpz/match.ts` | Ride matching for sync (line-for-line port of the Apps Script rules) and a CSV parser |
| `src/rpz/dates.ts` | Count windows and program week dates, in America/Chicago like the Sheet |
| `migrations/` | D1 schema (one table per Sheet tab) |
| `test/` | Tests; every request path asserts one round trip; bad input gets 400 with none |

Ported: `boot`, `me`, `progress`, `buddies`, `sync`, `join`, `settings`, `challengeView`, `toggleManual`,
`friendSearch`, `friendAdd`, `friendRemove`, `image`, `stravaConnect`, `stravaDisconnect`, `power`. Every
Apps Script call is ported. Strava sign-ins live in `strava_links` (migration 0002); set the secret with
`npx wrangler secret put STRAVA_CLIENT_SECRET`. Before 2027-06-01, switch `/oauth/deauthorize` to
Strava's replacement.

## Rules followed (from sourdoughrides.com's AGENTS.md)

- One D1 round trip per request (`batch()`); no queries in loops; every list query has a `LIMIT`.
- Request input is validated before any database work.
- Rider data lives in its own D1 database (`RPZ_DB`), separate from the core site's.
- Per-rider responses are `Cache-Control: no-store`; no logging on successful requests.
- The feature sits behind `RPZ_ENABLED` in `[vars]`.

## Cost notes (miss path; everything here is per-rider and never cached)

- **boot / me / progress / buddies:** one round trip each (boot: two only when the remembered
  challenge is gone). Progress reads one challenge's classes plus my rides of them; buddies also
  reads everyone's rides of that challenge's keys (the one read that grows with riders x classes).
- **sync:** two round trips (read, then one transaction that writes and reads back the profile).
  The phone trims the CSV to recent rides, so a normal sync parses a few dozen rows. A full-history
  sync (about 7,900 workouts, 1 MB) took about 240 ms locally: rare, but well over the 3 ms
  average, so it should stay the exception (it happens when a challenge's library is reloaded).
- **join, challengeView, toggleManual:** two round trips (check, then write). **settings, friendAdd,
  friendRemove, friendSearch:** one. Friend search scans the short riders table with `LIKE`
  (hundreds of rows, bounded by `LIMIT 20`).
- **image:** no D1 work; one fetch of the PNG from cdn.sourdoughrides.com (goes away if that site
  allows other sites to read it).
- Writes: only new rides (`INSERT ... ON CONFLICT DO NOTHING` on the ride's primary key) and the
  rider's last-sync time.

## One-time setup (on your computer)

```sh
git clone https://github.com/spinzalot/rpz-worker.git && cd rpz-worker
npm ci
npx wrangler login                     # opens the browser; sign in to Cloudflare
npx wrangler d1 create rpz             # only for a fresh account: paste its database_id into wrangler.toml
npm run db:migrate:remote              # creates the tables
```

## Copy the data from the Sheet

1. In the Sheet: **RPZ Admin > Export tables for Cloudflare**. It saves `rpz-d1-export.sql` to your Drive.
2. Download that file into this folder, then:

```sh
npx wrangler d1 execute rpz --remote --file rpz-d1-export.sql
rm rpz-d1-export.sql                   # it holds riders' details: don't commit it
```

Re-run both steps any time to refresh the Cloudflare copy (the file empties each table first).

## Deploy and test

```sh
npm test                               # runs locally in the Workers runtime
npm run deploy                         # prints your https://rpz-worker.<you>.workers.dev address
```

In Google Cloud Console (OAuth client), add that workers.dev address to the authorized JavaScript
origins only once the page itself is served from it; while the page stays on GitHub Pages, the
browser calls the Worker cross-origin, allowed by `ALLOWED_ORIGINS` in `wrangler.toml`.

## Dependencies

Installed from the public npm registry for now. Before offering any of this to
sourdoughrides.com, switch `.npmrc` to the Greenflagged registry (copy the line from Sean's
`worker/.npmrc`), run `npm login`, and reinstall, so every package has passed Greenflagged review.

## Auto-deploy (Cloudflare Workers Builds)

Every push to GitHub builds and tests the Worker on Cloudflare; a push to `main` then deploys it.
Same setup as sourdoughrides.com (its `worker/README.md`), adapted to this repo.

| Setting | Value |
|---|---|
| Repository | `spinzalot/rpz-worker`, root directory `/` |
| Production branch | `main` |
| Build command (every branch) | `npm config set --location=user "//greenflagged.dev/npm/:_authToken" "$GREENFLAGGED_NPM_TOKEN" && npm ci --silent && npm run check && npm test` |
| Deploy command (`main`) | `npm run db:migrate:remote && npx wrangler deploy` |
| Preview builds (other branches) | on |
| Preview command | `npx wrangler versions upload` (uploads a version, deploys nothing) |
| Build variables | `GREENFLAGGED_NPM_TOKEN` (encrypted), `NODE_VERSION` = `22.17.0` |

A failing check or test stops the build, so nothing broken deploys. New migrations apply on deploy;
D1 records which have run, so each runs once.
