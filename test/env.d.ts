// Bindings the tests see (from wrangler.toml, plus the migrations the test setup applies).
declare namespace Cloudflare {
  interface Env {
    RPZ_DB: D1Database;
    RPZ_ENABLED: string;
    GOOGLE_CLIENT_ID: string;
    ALLOWED_ORIGINS: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
