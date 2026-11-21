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
| `src/rpz/dates.ts` | Count windows and program week dates, in America/Chicago like the Sheet |
| `migrations/` | D1 schema (one table per Sheet tab) |
| `test/` | Tests; every request path asserts one round trip; bad input gets 400 with none |

Ported so far: `boot`, `me`, `progress`, `buddies`. Next: `sync`, settings, friends, manual marks,
challenge view, then Strava.

## Rules followed (from sourdoughrides.com's AGENTS.md)

- One D1 round trip per request (`batch()`); no queries in loops; every list query has a `LIMIT`.
- Request input is validated before any database work.
- Rider data lives in its own D1 database (`RPZ_DB`), separate from the core site's.
- Per-rider responses are `Cache-Control: no-store`; no logging on successful requests.
- The feature sits behind `RPZ_ENABLED` in `[vars]`.

## One-time setup (on your computer)

```sh
git clone https://github.com/spinzalot/rpz-worker.git && cd rpz-worker
npm ci
npx wrangler login                     # opens the browser; sign in to Cloudflare
npx wrangler d1 create rpz             # prints a database_id: paste it into wrangler.toml
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
