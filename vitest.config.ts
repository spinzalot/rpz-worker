import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
        SESSION_SECRET: 'test-session-secret-at-least-32-characters', DISCORD_CLIENT_SECRET: 'test-discord-secret' } },
    })),
  ],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
});
