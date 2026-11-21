// Database access for the RedditPZ features.
// Kysely builds the SQL (typed, bound parameters); D1 runs it. Every request sends all of its
// queries in ONE batch, so a page costs one round trip no matter how much data there is.
import { Kysely, DummyDriver, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, type Compilable } from 'kysely';

export interface ChallengeRow {
  id: string; name: string; kind: string; instructors: string; types: string;
  count_from: string | null; count_to: string | null; status: string;
  library_refreshed_on: string | null; hidden_by_default: number;
}
export interface ClassRow {
  challenge_id: string; peloton_class_id: string; class_key: string; title: string; instructor: string;
  length_min: number; type: string; air_epoch: number; week: number | null; slot: string;
  retired: number; added_on: string | null; source: string; seq: number;
}
export interface TypeRuleRow { ord: number; title_contains: string; type: string; grid_order: number | null }
export interface RiderRow {
  rider_id: string; email: string; peloton_username: string; discord_name: string; buddy_opt_in: number;
  joined_on: string | null; last_sync_on: string | null; status: string; visibility: string; challenge_view: string;
}
export interface CompletionRow { rider_id: string; ridden_at: number; class_key: string; source: string }
export interface FriendRow { rider_id: string; friend_id: string; added_on: string | null }
export interface ManualRow { rider_id: string; challenge_id: string; peloton_class_id: string; added_on: string | null }

export interface RpzDatabase {
  challenges: ChallengeRow;
  classes: ClassRow;
  type_rules: TypeRuleRow;
  riders: RiderRow;
  completions: CompletionRow;
  friends: FriendRow;
  manual: ManualRow;
  admins: { email: string };
  strava_links: { rider_id: string; athlete_id: number | null; name: string; ftp: number; access: string; refresh: string; expires_at: number };
}

/** Query builder only: it compiles SQL and never connects anywhere itself. */
export const qb = new Kysely<RpzDatabase>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

type Rows<Q> = Q extends Compilable<infer R> ? R[] : never;

/** Runs the queries in one D1 batch (one round trip) and returns each query's rows, in order. */
export async function batch<const Q extends readonly Compilable<unknown>[]>(
  db: D1Database, queries: Q,
): Promise<{ [K in keyof Q]: Rows<Q[K]> }> {
  const statements = queries.map((q) => {
    const c = q.compile();
    return db.prepare(c.sql).bind(...(c.parameters as unknown[]));
  });
  const results = await db.batch(statements);
  return results.map((r) => r.results) as { [K in keyof Q]: Rows<Q[K]> };
}
