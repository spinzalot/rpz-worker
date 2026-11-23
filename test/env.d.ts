// Bindings the tests see (from wrangler.toml, plus the migrations the test setup applies).
declare namespace Cloudflare {
  interface Env {
    RPZ_DB: D1Database;
    RPZ_ENABLED: string;
    GOOGLE_CLIENT_ID: string;
    ALLOWED_ORIGINS: string;
    STRAVA_CLIENT_ID: string;
    SESSION_SECRET: string;
    DISCORD_CLIENT_ID: string;
    DISCORD_CLIENT_SECRET: string;
    DISCORD_REDIRECT_URI: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
