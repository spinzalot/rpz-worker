// The RedditPZ JSON API. Same contract as the Apps Script prototype's doPost, so the page only
// changes the address it posts to: { token, action, ...params } -> { ok, data | error, ms }.
import { Hono } from 'hono';
import { sql } from 'kysely';
import { qb, batch, type RiderRow, type ChallengeRow } from './db';
import { verifyGoogleIdToken, type GoogleUser } from './auth';
import { countWindow, inWindow, programWeek1 } from './dates';

export interface RpzEnv {
  RPZ_DB: D1Database;
  RPZ_ENABLED: string;
  GOOGLE_CLIENT_ID: string;
  ALLOWED_ORIGINS: string;
}
export type Verify = (token: unknown, clientId: string) => Promise<GoogleUser>;

const ACTIONS = new Set(['me', 'progress']);   // more are ported in later steps
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

class UserError extends Error {}

// ---------- shared helpers ----------

function visibilityOf(r: Pick<RiderRow, 'visibility' | 'buddy_opt_in'>): string {
  const v = (r.visibility || '').trim();
  if (v === 'Everyone' || v === 'Friends' || v === 'Nobody') return v;
  return r.buddy_opt_in ? 'Everyone' : 'Nobody';
}
function checkActive(r: RiderRow | undefined): void {
  if (r && r.status !== 'Active') throw new UserError('This account is not active. Contact the RedditPZ admins.');
}
function requireRider(r: RiderRow | undefined): RiderRow {
  if (!r) throw new UserError('Please join first.');
  checkActive(r);
  return r;
}
function parseView(text: string) {
  const plus = new Set<string>(), minus = new Set<string>();
  (text || '').split(',').map((t) => t.trim()).forEach((t) => {
    if (t[0] === '+') plus.add(t.slice(1)); else if (t[0] === '-') minus.add(t.slice(1));
  });
  return { plus, minus };
}

// ---------- me ----------

export async function apiMe(db: D1Database, riderId: string, user: GoogleUser) {
  const [riders, last, friends, challenges, weeks, rules] = await batch(db, [
    qb.selectFrom('riders').selectAll().where('rider_id', '=', riderId),
    // Primary key prefix (rider_id, ridden_at): reads one index entry.
    qb.selectFrom('completions').select(sql<number>`max(ridden_at)`.as('last')).where('rider_id', '=', riderId),
    // My friends list, and whether each one shares with me. The inner lookup is one primary-key
    // seek per friend, and the outer side is my own short list, not a growing table.
    qb.selectFrom('friends as f').innerJoin('riders as r', 'r.rider_id', 'f.friend_id')
      .select(['r.peloton_username', 'r.visibility', 'r.buddy_opt_in',
        sql<number>`exists (select 1 from friends f2 where f2.rider_id = r.rider_id and f2.friend_id = ${riderId})`.as('lists_me')])
      .where('f.rider_id', '=', riderId).where('r.status', '=', 'Active').limit(500),
    qb.selectFrom('challenges').selectAll().where('status', '=', 'Active').limit(100),
    // Weeks per active program (display only): primary-key range per program challenge.
    qb.selectFrom('classes as c').innerJoin('challenges as ch', 'ch.id', 'c.challenge_id')
      .select(['c.challenge_id', sql<number>`max(c.week)`.as('weeks')])
      .where('ch.kind', '=', 'Program').where('ch.status', '=', 'Active').groupBy('c.challenge_id'),
    qb.selectFrom('type_rules').select(['type', 'grid_order']).where('grid_order', 'is not', null).orderBy('grid_order').limit(50),
  ] as const);

  const r = riders[0];
  checkActive(r);
  const weekOf = new Map(weeks.map((w) => [w.challenge_id, Number(w.weeks) || 0]));
  const view = parseView(r?.challenge_view || '');
  return {
    email: user.email,
    name: user.name,
    rider: r ? {
      pelotonUsername: r.peloton_username, discordName: r.discord_name, visibility: visibilityOf(r),
      lastSync: r.last_sync_on || '', lastRideAt: Number(last[0]?.last) || 0,
      strava: { connected: false },   // Strava moves over in a later step
    } : null,
    friends: r ? friends.map((f) => ({
      username: f.peloton_username,
      sharing: visibilityOf(f) === 'Everyone' || (visibilityOf(f) === 'Friends' && !!f.lists_me),
    })).sort((a, b) => a.username.localeCompare(b.username)) : [],
    challenges: challenges.map((c: ChallengeRow) => {
      const byDefault = !!c.hidden_by_default;
      return {
        id: c.id, name: c.name, kind: c.kind, refreshedOn: c.library_refreshed_on || '',
        week1: c.kind === 'Program' ? programWeek1(c.count_to, weekOf.get(c.id) || 0) : '',
        hiddenByDefault: byDefault,
        hidden: byDefault ? !view.plus.has(c.id) : view.minus.has(c.id),
      };
    }),
    typeOrder: rules.map((t) => t.type),
  };
}

// ---------- progress ----------

export async function apiProgress(db: D1Database, riderId: string, challengeId: string,
                                  includeRetired: boolean, includePrograms: boolean) {
  const [riders, chs, classes, rides, manual] = await batch(db, [
    qb.selectFrom('riders').selectAll().where('rider_id', '=', riderId),
    qb.selectFrom('challenges').selectAll().where('id', '=', challengeId).where('status', '=', 'Active'),
    // Primary-key range on challenge_id: reads only this challenge's classes.
    qb.selectFrom('classes').selectAll().where('challenge_id', '=', challengeId).where('type', '!=', 'Other')
      .orderBy('seq').limit(5000),   // a few hundred rows: sorting them costs nothing extra to read
    // My rides of this challenge's keys: primary-key range on my rides, each checked against the key index.
    qb.selectFrom('completions').select(['class_key', 'ridden_at']).where('rider_id', '=', riderId)
      .where('class_key', 'in', qb.selectFrom('classes').select('class_key').where('challenge_id', '=', challengeId))
      .orderBy('ridden_at').limit(20000),
    qb.selectFrom('manual').select('peloton_class_id').where('rider_id', '=', riderId).where('challenge_id', '=', challengeId).limit(5000),
  ] as const);

  requireRider(riders[0]);
  const ch = chs[0];
  if (!ch) throw new UserError('Unknown challenge.');
  const typeOrder = ch.types.split(',').map((s) => s.trim()).filter(Boolean);

  const win = countWindow(ch.count_from, ch.count_to);
  const byKey = new Map<string, number[]>();   // class key -> ride times, oldest first
  for (const r of rides) {
    if (!inWindow(win, r.ridden_at)) continue;
    if (!byKey.has(r.class_key)) byKey.set(r.class_key, []);
    byKey.get(r.class_key)!.push(r.ridden_at);
  }
  const marked = new Set(manual.map((m) => m.peloton_class_id));

  // Classes sharing a key (twins in a program) are credited in order, one per ride.
  const groups = new Map<string, typeof classes>();
  for (const c of classes) {
    if (!groups.has(c.class_key)) groups.set(c.class_key, []);
    groups.get(c.class_key)!.push(c);
  }
  const out: Array<Record<string, unknown> & { air: number; done: boolean; retired: boolean; program: boolean; len: number; type: string }> = [];
  groups.forEach((members, k) => {
    const times = (byKey.get(k) || []).slice();
    for (const m of members) {
      const rodeAt = times.length ? times.shift()! : 0;
      const ridden = rodeAt > 0;
      const man = !ridden && marked.has(m.peloton_class_id);
      out.push({
        id: m.peloton_class_id, title: m.title, len: m.length_min, type: m.type, air: m.air_epoch,
        done: ridden || man, retired: !!m.retired, program: m.source === 'Program', instructor: m.instructor || '',
        manual: man, week: m.week ?? null, slot: m.slot || '', rodeAt,
      });
    }
  });

  const visible = out.filter((c) => (!c.retired || (includeRetired && c.done)) && (includePrograms || !c.program));
  visible.sort((a, b) => b.air - a.air);
  return {
    challenge: { id: ch.id, name: ch.name, kind: ch.kind },
    done: visible.filter((c) => c.done).length,
    total: visible.length,
    lengths: [...new Set(visible.map((c) => c.len))].sort((a, b) => a - b),
    types: typeOrder.filter((t) => visible.some((c) => c.type === t)),
    classes: visible,
  };
}

// ---------- the route ----------

export function rpzApi(verify: Verify = verifyGoogleIdToken) {
  const app = new Hono<{ Bindings: RpzEnv }>();

  app.use('*', async (c, next) => {
    if (c.env.RPZ_ENABLED !== 'true') return c.notFound();
    const origin = c.req.header('origin') || '';
    const allowed = (c.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).includes(origin);
    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: allowed ? {
        'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin',
      } : {} });
    }
    await next();
    c.res.headers.set('Cache-Control', 'no-store');   // per-rider data: never cached
    if (allowed) { c.res.headers.set('Access-Control-Allow-Origin', origin); c.res.headers.set('Vary', 'Origin'); }
  });

  app.post('/', async (c) => {
    const t0 = Date.now();
    let req: Record<string, unknown>;
    try { req = await c.req.json(); } catch { return c.json({ ok: false, error: 'Bad request.' }, 400); }
    const action = String(req.action || '');
    // Bad input gets a 400 before any database work.
    if (!ACTIONS.has(action)) return c.json({ ok: false, error: 'Unknown request.' }, 400);
    if (action === 'progress' && !ID_RE.test(String(req.challengeId || ''))) {
      return c.json({ ok: false, error: 'Bad challenge.' }, 400);
    }
    try {
      const user = await verify(req.token, c.env.GOOGLE_CLIENT_ID);
      const authMs = Date.now() - t0;
      const riderId = 'google:' + user.sub;
      const db = c.env.RPZ_DB;
      let data: unknown;
      if (action === 'me') data = await apiMe(db, riderId, user);
      else data = await apiProgress(db, riderId, String(req.challengeId), !!req.includeRetired, req.includePrograms !== false);
      return c.json({ ok: true, data, ms: Date.now() - t0, authMs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const known = err instanceof UserError || /^(SIGNIN_|Please sign in)/.test(msg);
      if (!known) console.error('rpz api', action, msg);   // log errors only, never successes
      return c.json({ ok: false, error: known ? msg : 'Something went wrong.', ms: Date.now() - t0 });
    }
  });

  return app;
}
