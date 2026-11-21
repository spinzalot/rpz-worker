import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Every test file starts from the schema in migrations/ (and an empty database).
await applyD1Migrations(env.RPZ_DB, env.TEST_MIGRATIONS);
