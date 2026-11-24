// The RedditPZ JSON API. Same contract as the Apps Script prototype's doPost, so the page only
// changes the address it posts to: { token, action, ...params } -> { ok, data | error, ms }.
//
// Each call is split into its queries and a build step, so several calls can share ONE D1 batch:
// boot (profile + progress + buddies) is a single round trip like the others.
import { Hono } from 'hono';
import { sql, type Compilable } from 'kysely';
import { qb, type RiderRow, type ChallengeRow, type ClassRow } from './db';
import { verifyGoogleIdToken, type GoogleUser } from './auth';
import { signSession, verifySession, discordIdentity, PROVIDERS, type Provider, type Who } from './session';
import { countWindow, inWindow, programWeek1, dayStart, addDays, tzOffset, RPZ_TZ } from './dates';
import { matchRides, typeClassifier, type MatchedRide } from './match';
import { stravaLinkQuery, stravaStatus, stravaConnect, stravaDisconnect, stravaPower, type StravaEnv, type StravaLink } from './strava';

export interface RpzEnv extends StravaEnv {
  RPZ_DB: D1Database;
  RPZ_ENABLED: string;
  GOOGLE_CLIENT_ID: string;
  ALLOWED_ORIGINS: string;
  SESSION_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_REDIRECT_URI?: string;
}
/** Who is asking, as the calls need it: display name, and the sign-in used (for joining). */
export interface User { name: string; email?: string; provider?: Provider; subject?: string; sub?: string }
export type Verify = (token: unknown, clientId: string) => Promise<GoogleUser>;

const ACTIONS = new Set(['signin', 'link', 'unlink', 'boot', 'me', 'progress', 'buddies', 'sync', 'join', 'settings', 'challengeView',
  'toggleManual', 'friendSearch', 'friendAdd', 'friendRemove', 'image', 'stravaConnect', 'stravaDisconnect', 'power',
  'groupRide', 'groupRsvp']);
const CLASS_RE = /^[0-9a-f]{32}$/;
const MAX_CSV = 8 * 1024 * 1024;   // a full Peloton history is about 1 MB
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;

import { UserError } from './errors';
export { UserError };

/** A call's queries plus how to turn their rows into the response. */
interface Part<T> { queries: Compilable<unknown>[]; build: (rows: unknown[][]) => T }

/** Runs any number of parts in one D1 batch. */
/** What one request cost in D1: round trips, rows read and rows written (D1's billing units). Returned
 *  with each response so the page's ?debug view shows it; nothing is logged. */
export interface Meter { trips: number; read: number; written: number }
function metered(db: D1Database, meter: Meter): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') return async (stmts: D1PreparedStatement[]) => {
        const res = await target.batch(stmts);
        meter.trips++;
        for (const r of res) { meter.read += r.meta?.rows_read ?? 0; meter.written += r.meta?.rows_written ?? 0; }
        return res;
      };
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

async function run<const P extends readonly Part<unknown>[]>(db: D1Database, parts: P):
    Promise<{ [K in keyof P]: P[K] extends Part<infer T> ? T : never }> {
  const all = parts.flatMap((p) => p.queries);
  const results = await db.batch(all.map((q) => {
    const c = q.compile();
    return db.prepare(c.sql).bind(...(c.parameters as unknown[]));
  }));
  let i = 0;
  return parts.map((p) => {
    const rows = results.slice(i, i + p.queries.length).map((r) => r.results);
    i += p.queries.length;
    return p.build(rows);
  }) as { [K in keyof P]: P[K] extends Part<infer T> ? T : never };
}

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
const riderQuery = (riderId: string) => qb.selectFrom('riders').selectAll().where('rider_id', '=', riderId);
const challengeQuery = (id: string) => qb.selectFrom('challenges').selectAll().where('id', '=', id).where('status', '=', 'Active');

/** Groups classes by key, in load order (twins sharing a key are credited in this order). */
function groupByKey(classes: ClassRow[]): Map<string, ClassRow[]> {
  const groups = new Map<string, ClassRow[]>();
  for (const c of classes) {
    if (!groups.has(c.class_key)) groups.set(c.class_key, []);
    groups.get(c.class_key)!.push(c);
  }
  return groups;
}

// ---------- friends list ----------

type FriendListRow = { peloton_username: string; visibility: string; buddy_opt_in: number; lists_me: number };
/** My friends list, and whether each one shares with me. The inner lookup is one primary-key
 *  seek per friend, and the outer side is my own short list, not a growing table. */
const friendsQuery = (riderId: string) =>
  qb.selectFrom('friends as f').innerJoin('riders as r', 'r.rider_id', 'f.friend_id')
    .select(['r.peloton_username', 'r.visibility', 'r.buddy_opt_in',
      sql<number>`exists (select 1 from friends f2 where f2.rider_id = r.rider_id and f2.friend_id = ${riderId})`.as('lists_me')])
    .where('f.rider_id', '=', riderId).where('r.status', '=', 'Active').limit(500);
const buildFriends = (rows: FriendListRow[]) => rows.map((f) => ({
  username: f.peloton_username,
  sharing: visibilityOf(f) === 'Everyone' || (visibilityOf(f) === 'Friends' && !!f.lists_me),
})).sort((a, b) => a.username.localeCompare(b.username));

// ---------- me ----------

export function meQuery(riderId: string, user: User): Part<ReturnType<typeof buildMe>> {
  return {
    queries: [
      riderQuery(riderId),
      // Primary key prefix (rider_id, ridden_at): reads one index entry.
      qb.selectFrom('completions').select(sql<number>`max(ridden_at)`.as('last')).where('rider_id', '=', riderId),
      friendsQuery(riderId),
      qb.selectFrom('challenges').selectAll().where('status', '=', 'Active').limit(100),
      // Weeks per active program (display only): primary-key range per program challenge.
      qb.selectFrom('classes as c').innerJoin('challenges as ch', 'ch.id', 'c.challenge_id')
        .select(['c.challenge_id', sql<number>`max(c.week)`.as('weeks')])
        .where('ch.kind', '=', 'Program').where('ch.status', '=', 'Active').groupBy('c.challenge_id'),
      qb.selectFrom('type_rules').select(['type', 'grid_order']).where('grid_order', 'is not', null).orderBy('grid_order').limit(50),
      stravaLinkQuery(riderId),
      qb.selectFrom('identities').select(['provider', 'name']).where('rider_id', '=', riderId).limit(10),
    ],
    build: (rows) => buildMe(rows, user),
  };
}

function buildMe(rows: unknown[][], user: User) {
  const [riders, last, friends, challenges, weeks, rules, strava, ids] = rows as [
    RiderRow[], { last: number | null }[],
    FriendListRow[], ChallengeRow[], { challenge_id: string; weeks: number | null }[], { type: string }[], StravaLink[],
    { provider: string; name: string }[]];
  const r = riders[0];
  checkActive(r);
  const weekOf = new Map(weeks.map((w) => [w.challenge_id, Number(w.weeks) || 0]));
  const view = parseView(r?.challenge_view || '');
  return {
    email: user.email || '',
    name: user.name,
    // Sign-in methods on this account, in button order (Discord, Reddit, Google).
    signins: PROVIDERS.filter((p) => (ids || []).some((i) => i.provider === p))
      .map((p) => ({ provider: p, name: (ids || []).find((i) => i.provider === p)!.name })),
    rider: r ? {
      pelotonUsername: r.peloton_username, discordName: r.discord_name, visibility: visibilityOf(r),
      lastSync: r.last_sync_on || '', lastRideAt: Number(last[0]?.last) || 0,
      strava: stravaStatus(strava[0]),
    } : null,
    friends: r ? buildFriends(friends) : [],
    challenges: challenges.map((c) => {
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

export function progressQuery(riderId: string, challengeId: string, includeRetired: boolean, includePrograms: boolean) {
  return {
    queries: [
      riderQuery(riderId),
      challengeQuery(challengeId),
      // Primary-key range on challenge_id: reads only this challenge's classes (a few hundred rows).
      qb.selectFrom('classes').selectAll().where('challenge_id', '=', challengeId).where('type', '!=', 'Other')
        .orderBy('seq').limit(5000),
      // My rides of this challenge's keys: primary-key range on my rides.
      qb.selectFrom('completions').select(['class_key', 'ridden_at']).where('rider_id', '=', riderId)
        .where('class_key', 'in', qb.selectFrom('classes').select('class_key').where('challenge_id', '=', challengeId))
        .orderBy('ridden_at').limit(20000),
      qb.selectFrom('manual').select('peloton_class_id').where('rider_id', '=', riderId).where('challenge_id', '=', challengeId).limit(5000),
    ],
    build: (rows: unknown[][]) => buildProgress(rows, includeRetired, includePrograms),
  } satisfies Part<unknown>;
}

function buildProgress(rows: unknown[][], includeRetired: boolean, includePrograms: boolean) {
  const [riders, chs, classes, rides, manual] = rows as [
    RiderRow[], ChallengeRow[], ClassRow[], { class_key: string; ridden_at: number }[], { peloton_class_id: string }[]];
  requireRider(riders[0]);
  const ch = chs[0];
  if (!ch) throw new UserError('Unknown challenge.');
  const typeOrder = ch.types.split(',').map((s) => s.trim()).filter(Boolean);

  const win = countWindow(ch.count_from, ch.count_to);
  const byKey = new Map<string, number[]>();   // class key -> ride times in the window, oldest first
  const outside = new Map<string, number[]>(); // class key -> ride times outside it, newest first
  for (const r of rides) {
    const m = inWindow(win, r.ridden_at) ? byKey : outside;
    if (!m.has(r.class_key)) m.set(r.class_key, []);
    m.get(r.class_key)!.push(r.ridden_at);
  }
  outside.forEach((l) => l.reverse());
  const marked = new Set(manual.map((m) => m.peloton_class_id));

  const out: Array<{ id: string; title: string; len: number; type: string; air: number; done: boolean; retired: boolean;
    program: boolean; instructor: string; manual: boolean; week: number | null; slot: string; rodeAt: number;
    otherAt: number }> = [];
  groupByKey(classes).forEach((members, k) => {
    const times = (byKey.get(k) || []).slice(), others = (outside.get(k) || []).slice();
    for (const m of members) {
      // Twins share a key: each takes the next ride, oldest first. A class with no twin gets its latest ride.
      const rodeAt = !times.length ? 0 : members.length === 1 ? times[times.length - 1] : times.shift()!;
      const ridden = rodeAt > 0;
      const man = !ridden && marked.has(m.peloton_class_id);
      // Ridden, but before or after the challenge's window: shown, not counted. Sent even when the class is
      // checked by hand, so unchecking it brings the ↺ back without a reload.
      const otherAt = !ridden && others.length ? others.shift()! : 0;
      out.push({
        id: m.peloton_class_id, title: m.title, len: m.length_min, type: m.type, air: m.air_epoch,
        done: ridden || man, retired: !!m.retired, program: m.source === 'Program', instructor: m.instructor || '',
        manual: man, week: m.week ?? null, slot: m.slot || '', rodeAt, otherAt,
      });
    }
  });

  const visible = out.filter((c) => (!c.retired || (includeRetired && c.done)) && (includePrograms || !c.program));
  visible.sort((a, b) => b.air - a.air);
  return {
    challenge: { id: ch.id, name: ch.name, kind: ch.kind },
    done: visible.filter((c) => c.done).length,
    total: visible.length,
    other: visible.filter((c) => !c.done && c.otherAt > 0).length,
    window: { from: ch.count_from || '', to: ch.count_to || '' },
    lengths: [...new Set(visible.map((c) => c.len))].sort((a, b) => a - b),
    types: typeOrder.filter((t) => visible.some((c) => c.type === t)),
    classes: visible,
  };
}

// ---------- buddies ----------

/**
 * My remaining classes, each with the riders who share with me and still need it too.
 * With riders selected, only classes that all of them (and I) still need are returned.
 * A rider shares with me if their visibility is Everyone, or Friends and I'm on their list.
 */
export function buddiesQuery(riderId: string, challengeId: string, selected: string[], includePrograms: boolean) {
  return {
    queries: [
      // Active riders: one short table (hundreds of rows), read once.
      qb.selectFrom('riders').select(['rider_id', 'peloton_username', 'discord_name', 'visibility', 'buddy_opt_in', 'status'])
        .where('status', '=', 'Active').limit(5000),
      challengeQuery(challengeId),
      qb.selectFrom('classes').selectAll().where('challenge_id', '=', challengeId).where('type', '!=', 'Other')
        .where('retired', '=', 0).orderBy('seq').limit(5000),
      // Everyone's rides of this challenge's keys, via the (class_key, rider_id) index. This is the
      // read that grows with riders x classes; see README for the arithmetic.
      qb.selectFrom('completions').select(['rider_id', 'class_key', 'ridden_at'])
        .where('class_key', 'in', qb.selectFrom('classes').select('class_key').where('challenge_id', '=', challengeId))
        .limit(200000),
      qb.selectFrom('manual').select(['rider_id', 'peloton_class_id']).where('challenge_id', '=', challengeId).limit(50000),
      // Friends rows that touch me: my list, and the lists I'm on.
      qb.selectFrom('friends').select(['rider_id', 'friend_id'])
        .where((eb) => eb.or([eb('rider_id', '=', riderId), eb('friend_id', '=', riderId)])).limit(10000),
    ],
    build: (rows: unknown[][]) => buildBuddies(rows, riderId, selected, includePrograms),
  } satisfies Part<unknown>;
}

function buildBuddies(rows: unknown[][], riderId: string, selected: string[], includePrograms: boolean) {
  const [riders, chs, allClasses, rides, manual, friends] = rows as [
    Pick<RiderRow, 'rider_id' | 'peloton_username' | 'discord_name' | 'visibility' | 'buddy_opt_in' | 'status'>[],
    ChallengeRow[], ClassRow[], { rider_id: string; class_key: string; ridden_at: number }[],
    { rider_id: string; peloton_class_id: string }[], { rider_id: string; friend_id: string }[]];
  const me = riders.find((r) => r.rider_id === riderId);
  if (!me) throw new UserError('Please join first.');   // inactive riders aren't in the list either
  const ch = chs[0];
  if (!ch) throw new UserError('Unknown challenge.');

  const win = countWindow(ch.count_from, ch.count_to);
  const classes = allClasses.filter((c) => includePrograms || c.source !== 'Program');
  const groups = groupByKey(classes);

  const ridesBy = new Map<string, Map<string, number>>();   // rider -> class key -> rides
  for (const r of rides) {
    if (!inWindow(win, r.ridden_at)) continue;
    if (!ridesBy.has(r.rider_id)) ridesBy.set(r.rider_id, new Map());
    const m = ridesBy.get(r.rider_id)!;
    m.set(r.class_key, (m.get(r.class_key) || 0) + 1);
  }
  const manualBy = new Map<string, Set<string>>();
  for (const m of manual) {
    if (!manualBy.has(m.rider_id)) manualBy.set(m.rider_id, new Set());
    manualBy.get(m.rider_id)!.add(m.peloton_class_id);
  }
  const doneBy = (id: string) => {
    const done = new Set<string>(manualBy.get(id) || []);
    const mine = ridesBy.get(id) || new Map<string, number>();
    groups.forEach((members, k) => members.slice(0, mine.get(k) || 0).forEach((m) => done.add(m.peloton_class_id)));
    return done;
  };

  const myList = new Set(friends.filter((f) => f.rider_id === riderId).map((f) => f.friend_id));
  const listsMe = new Set(friends.filter((f) => f.friend_id === riderId).map((f) => f.rider_id));
  const canSee = (r: typeof me) => {
    const v = visibilityOf(r);
    return v === 'Everyone' || (v === 'Friends' && listsMe.has(r.rider_id));
  };
  const others = riders.filter((r) => r.rider_id !== riderId && canSee(r));
  const othersDone = others.map((r) => ({ r, done: doneBy(r.rider_id) }));
  const myDone = doneBy(riderId);

  let list: Array<{ id: string; title: string; instructor: string; len: number; type: string; air: number;
    program: boolean; week: number | null; slot: string; buddies: string[] }> = [];
  groups.forEach((members) => members.forEach((m) => {
    if (myDone.has(m.peloton_class_id)) return;
    list.push({
      id: m.peloton_class_id, title: m.title, instructor: m.instructor, len: m.length_min, type: m.type,
      air: m.air_epoch, program: m.source === 'Program', week: m.week ?? null, slot: m.slot || '',
      buddies: othersDone.filter((o) => !o.done.has(m.peloton_class_id)).map((o) => o.r.peloton_username),
    });
  }));
  if (selected.length) list = list.filter((c) => selected.every((u) => c.buddies.includes(u)));
  list.sort((a, b) => (b.buddies.length - a.buddies.length) || (b.air - a.air));

  return {
    visibility: visibilityOf(me),
    riders: others.map((r) => ({ username: r.peloton_username, discord: r.discord_name || '', friend: myList.has(r.rider_id) }))
      .sort((a, b) => a.username.localeCompare(b.username)),
    classes: list,
  };
}

// ---------- sync ----------

/**
 * Matches the rider's Peloton CSV (usually trimmed on the phone to recent rides) and stores new rides.
 * Two round trips: read what matching needs, then one transaction that stores the new rides and
 * reads back the profile. A ride (rider + start time) is stored once: the primary key enforces it,
 * so two syncs at the same moment can't double-count and no lock is needed.
 */
export async function apiSync(db: D1Database, riderId: string, user: User, csvText: string) {
  if (!csvText || csvText.length < 50) throw new UserError('That file looks empty. Pick your Peloton workouts CSV.');
  const active = qb.selectFrom('challenges').select('id').where('status', '=', 'Active');
  const [riders, challenges, classes, rules, before] = (await run(db, [{
    queries: [
      riderQuery(riderId),
      qb.selectFrom('challenges').selectAll().where('status', '=', 'Active').limit(100),
      // Classes of active challenges: primary-key ranges, a few hundred rows each.
      qb.selectFrom('classes').selectAll().where('challenge_id', 'in', active).orderBy('seq').limit(20000),
      qb.selectFrom('type_rules').selectAll().limit(50),
      qb.selectFrom('completions').select(['class_key', 'ridden_at']).where('rider_id', '=', riderId).limit(50000),
    ],
    build: (rows) => rows,
  }] as const))[0] as [RiderRow[], ChallengeRow[], ClassRow[], { ord: number; title_contains: string; type: string }[],
    { class_key: string; ridden_at: number }[]];
  const rider = requireRider(riders[0]);

  let m;
  try {
    m = matchRides(csvText, classes.filter((c) => !c.retired), typeClassifier(rules), rider.peloton_username);
  } catch (e) { throw new UserError(e instanceof Error ? e.message : String(e)); }

  const stored = new Set(before.map((b) => b.ridden_at));
  const added: MatchedRide[] = [];
  for (const r of m.rides) if (!stored.has(r.riddenAt)) { stored.add(r.riddenAt); added.push(r); }

  // Writes and the fresh profile in one transaction. D1 allows 100 bound values per statement,
  // so new rides go in 25 at a time (4 values each).
  const writes: Compilable<unknown>[] = [];
  for (let i = 0; i < added.length; i += 25) {
    writes.push(qb.insertInto('completions')
      .values(added.slice(i, i + 25).map((r) => ({ rider_id: riderId, ridden_at: r.riddenAt, class_key: r.key, source: 'sync' })))
      .onConflict((oc) => oc.doNothing()));
  }
  writes.push(qb.updateTable('riders').set({ last_sync_on: new Date().toISOString() }).where('rider_id', '=', riderId));
  const [, me] = await run(db, [{ queries: writes, build: () => null }, meQuery(riderId, user)] as const);

  // What changed, per active challenge, within each count window (retired and program classes included).
  const beforeRides = before.map((b) => ({ key: b.class_key, riddenAt: b.ridden_at }));
  const afterRides = beforeRides.concat(added);
  const tally = (rides: MatchedRide[], win: ReturnType<typeof countWindow>) => {
    const t = new Map<string, number>();
    for (const r of rides) if (inWindow(win, r.riddenAt)) t.set(r.key, (t.get(r.key) || 0) + 1);
    return t;
  };
  const newly: { id: string; challenge: string; titles: string[] }[] = [];
  const lines = [`${rider.peloton_username}: ${m.cycling} cycling rides in file, ${m.matched} matched` +
    (m.viaUtc ? ` (${m.viaUtc} with an export time off by 30+ min` + (m.guessed ? `, ${m.guessed} of them to classes with no known instructor` : '') + ')' : '') +
    `, ${added.length} new.`];
  for (const ch of challenges) {
    const win = countWindow(ch.count_from, ch.count_to);
    const was = tally(beforeRides, win), now = tally(afterRides, win);
    const groups = groupByKey(classes.filter((c) => c.challenge_id === ch.id && c.type !== 'Other'));
    const titles: string[] = [];
    let done = 0, total = 0;
    groups.forEach((members, k) => {
      const a = Math.min(members.length, was.get(k) || 0), b = Math.min(members.length, now.get(k) || 0);
      members.slice(a, b).forEach((x) => titles.push(x.title));
      done += b; total += members.length;
    });
    if (titles.length) newly.push({ id: ch.id, challenge: ch.name, titles });
    lines.push(`  ${ch.id}: ${done} / ${total} done`);
  }
  if (m.misses.length) {
    lines.push('  Possible misses (a challenge has a class with this title and length, but none close enough in time): ' + m.misses.length);
    m.misses.slice(0, 8).forEach((x) => lines.push('    ' + x));
    if (m.misses.length > 8) lines.push('    ...');
  }
  return { report: lines.join('\n'), newly, me };
}

// ---------- join and settings ----------

/**
 * First visit: links the Google account to a Peloton username. If the username was synced before
 * sign-in existed (rider id 'peloton:<username>' with no email), that history is claimed.
 */
export async function apiJoin(db: D1Database, riderId: string, user: User, pelotonUsername: unknown, discordName: unknown) {
  const name = String(pelotonUsername ?? '').trim();
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(name)) throw new UserError('Enter your Peloton username exactly as it appears on your profile.');
  // Signed in with Discord: its account id fills in the Discord field for buddy posts, unless given.
  const discord = (String(discordName ?? '').trim() || (user.provider === 'discord' ? user.subject || '' : '')).slice(0, 40);
  const [[found, takenBy]] = await run(db, [{ queries: [
    qb.selectFrom('riders').selectAll()
      .where((eb) => eb.or([eb('rider_id', '=', riderId), eb(sql`peloton_username collate nocase`, '=', name)])).limit(5),
    // How the account with that username signs in, to point someone back to it.
    qb.selectFrom('identities as i').innerJoin('riders as r', 'r.rider_id', 'i.rider_id').select('i.provider')
      .where(sql`r.peloton_username collate nocase`, '=', name).limit(5),
  ], build: (rows) => rows as [RiderRow[], { provider: string }[]] }] as const);

  const writes: Compilable<unknown>[] = [];
  const mine = found.find((r) => r.rider_id === riderId);
  const sameName = found.find((r) => r.rider_id !== riderId && r.peloton_username.toLowerCase() === name.toLowerCase());
  if (mine) {
    writes.push(qb.updateTable('riders').set({ discord_name: discord }).where('rider_id', '=', riderId));
  } else if (sameName && !(sameName.rider_id.startsWith('peloton:') && !sameName.email)) {
    const ways = PROVIDERS.filter((p) => takenBy.some((t) => t.provider === p)).map(providerName);
    throw new UserError(ways.length
      ? `${sameName.peloton_username} is already registered. Sign in with ${ways.join(' or ')} to use that account; you can add ` +
        `${providerName(user.provider || 'google')} sign-in from Settings ⚙ afterwards.`
      : 'That Peloton username is already linked to another account. Contact the RedditPZ admins.');
  } else if (sameName) {   // claim pre-sign-in history
    writes.push(qb.updateTable('riders').set({ rider_id: riderId, email: '', discord_name: discord }).where('rider_id', '=', sameName.rider_id));
    writes.push(qb.updateTable('completions').set({ rider_id: riderId }).where('rider_id', '=', sameName.rider_id));
  } else {
    writes.push(qb.insertInto('riders').values({
      rider_id: riderId, email: '', peloton_username: name, discord_name: discord, buddy_opt_in: 0,
      joined_on: new Date().toISOString(), last_sync_on: null, status: 'Active', visibility: '', challenge_view: '',
    }).onConflict((oc) => oc.doNothing()));
  }
  if (user.provider && user.subject) writes.push(identityInsert(user.provider, user.subject, riderId, user.name));
  const [, me] = await run(db, [{ queries: writes, build: () => null }, meQuery(riderId, user)] as const);
  return me;
}

/** Discord ID and buddy visibility. One round trip: the update, then the fresh profile. */
export async function apiSettings(db: D1Database, riderId: string, user: User, discordName: unknown, visibility: unknown) {
  const discord = String(discordName ?? '').trim().replace(/^@+/, '').slice(0, 40);
  const vis = ['Everyone', 'Friends', 'Nobody'].includes(String(visibility)) ? String(visibility) : 'Nobody';
  const [, me] = await run(db, [{ queries: [
    qb.updateTable('riders').set({ discord_name: discord, visibility: vis, buddy_opt_in: vis !== 'Nobody' ? 1 : 0 })
      .where('rider_id', '=', riderId).where('status', '=', 'Active'),
  ], build: () => null }, meQuery(riderId, user)] as const);
  if (!me.rider) throw new UserError('Please join first.');
  return me;
}

/** Which challenges I hide from my picker (at least one must stay shown). Stores only my departures from the defaults. */
export async function apiChallengeView(db: D1Database, riderId: string, user: User, hiddenIds: unknown) {
  const hidden = new Set((Array.isArray(hiddenIds) ? hiddenIds : []).map(String));
  const [[riders, active]] = await run(db, [{ queries: [
    riderQuery(riderId), qb.selectFrom('challenges').select(['id', 'hidden_by_default']).where('status', '=', 'Active').limit(100),
  ], build: (rows) => rows as [RiderRow[], Pick<ChallengeRow, 'id' | 'hidden_by_default'>[]] }] as const);
  requireRider(riders[0]);
  if (active.length && active.every((c) => hidden.has(c.id))) throw new UserError('Keep at least one challenge.');
  const tokens: string[] = [];
  for (const c of active) {
    const hide = hidden.has(c.id);
    if (hide && !c.hidden_by_default) tokens.push('-' + c.id);
    if (!hide && c.hidden_by_default) tokens.push('+' + c.id);
  }
  const [, me] = await run(db, [{ queries: [
    qb.updateTable('riders').set({ challenge_view: tokens.join(',') }).where('rider_id', '=', riderId),
  ], build: () => null }, meQuery(riderId, user)] as const);
  return me;
}

/** Adds or removes my manual (gray) check on one class of a challenge. */
export async function apiToggleManual(db: D1Database, riderId: string, challengeId: string, classId: string) {
  const [[riders, cls, existing]] = await run(db, [{ queries: [
    riderQuery(riderId),
    qb.selectFrom('classes').select('peloton_class_id').where('challenge_id', '=', challengeId).where('peloton_class_id', '=', classId),
    qb.selectFrom('manual').select('peloton_class_id')
      .where('rider_id', '=', riderId).where('challenge_id', '=', challengeId).where('peloton_class_id', '=', classId),
  ], build: (rows) => rows as [RiderRow[], unknown[], unknown[]] }] as const);
  requireRider(riders[0]);
  if (!cls.length) throw new UserError('Unknown class.');
  const key = { rider_id: riderId, challenge_id: challengeId, peloton_class_id: classId };
  if (existing.length) {
    await run(db, [{ queries: [qb.deleteFrom('manual').where('rider_id', '=', riderId).where('challenge_id', '=', challengeId)
      .where('peloton_class_id', '=', classId)], build: () => null }] as const);
    return { manual: false };
  }
  await run(db, [{ queries: [qb.insertInto('manual').values({ ...key, added_on: new Date().toISOString() }).onConflict((oc) => oc.doNothing())],
    build: () => null }] as const);
  return { manual: true };
}

// ---------- group rides ----------
// A weekly group ride on the current program's class for that day: the Saturday ride starts at 9:59 AM
// Central. Add an entry here for another (an early-bird ride: same day, an earlier time).
export const GROUP_RIDES: Record<string, { label: string; weekday: number; slot: string; hour: number; minute: number }> = {
  sat: { label: 'Saturday ride', weekday: 6, slot: 'Sat', hour: 9, minute: 59 },
};
const RIDE_OPEN_AFTER_START = 3 * 3600;   // the card stays on this ride until 3 hours after the start

/** Which ride is next (or under way) at `now`: its local date, start and id. */
export function nextGroupRide(key: string, now: number) {
  const def = GROUP_RIDES[key];
  if (!def) throw new UserError('Unknown group ride.');
  const today = new Date((now + tzOffset(now, RPZ_TZ)) * 1000).toISOString().slice(0, 10);
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  let ymd = addDays(today, (def.weekday - dow + 7) % 7);
  const startOf = (d: string) => (dayStart(d) as number) + def.hour * 3600 + def.minute * 60;
  if (now >= startOf(ymd) + RIDE_OPEN_AFTER_START) ymd = addDays(ymd, 7);
  return { key, id: key + '-' + ymd, date: ymd, startsAt: startOf(ymd), label: def.label, slot: def.slot };
}

interface RsvpRow { rider_id: string; status: string; peloton_username: string }
function groupRideParts(riderId: string, ride: ReturnType<typeof nextGroupRide>) {
  return {
    queries: [
      // Programs whose count window covers the ride's day, with their class for that slot.
      qb.selectFrom('classes as c').innerJoin('challenges as ch', 'ch.id', 'c.challenge_id')
        .select(['ch.id as challenge_id', 'ch.name', 'ch.count_to', 'c.peloton_class_id', 'c.class_key', 'c.title', 'c.instructor',
                 'c.length_min', 'c.type', 'c.week'])
        .where('ch.kind', '=', 'Program').where('ch.status', '=', 'Active')
        .where('ch.count_from', '<=', ride.date).where('ch.count_to', '>=', ride.date).where('c.slot', '=', ride.slot),
      qb.selectFrom('classes as c').innerJoin('challenges as ch', 'ch.id', 'c.challenge_id')
        .select(['c.challenge_id', sql<number>`max(c.week)`.as('weeks')])
        .where('ch.kind', '=', 'Program').where('ch.status', '=', 'Active')
        .where('ch.count_from', '<=', ride.date).where('ch.count_to', '>=', ride.date).groupBy('c.challenge_id'),
      qb.selectFrom('group_rsvps as g').innerJoin('riders as r', 'r.rider_id', 'g.rider_id')
        .select(['g.rider_id', 'g.status', 'r.peloton_username']).where('g.event_id', '=', ride.id).orderBy('g.updated_on'),
      // Only my rides of the candidate classes (a handful of rows, not my whole history).
      qb.selectFrom('completions').select('class_key').where('rider_id', '=', riderId)
        .where('class_key', 'in', qb.selectFrom('classes as c').innerJoin('challenges as ch', 'ch.id', 'c.challenge_id').select('c.class_key')
          .where('ch.kind', '=', 'Program').where('ch.count_from', '<=', ride.date).where('ch.count_to', '>=', ride.date)
          .where('c.slot', '=', ride.slot)),
    ],
    build: (rows: unknown[][]) => {
      const [cls, weeks, rsvps, mine] = rows as [
        { challenge_id: string; name: string; count_to: string; peloton_class_id: string; class_key: string; title: string;
          instructor: string; length_min: number; type: string; week: number }[],
        { challenge_id: string; weeks: number }[], RsvpRow[], { class_key: string }[]];
      // The program's week for the ride's day; the newest program wins if two overlap.
      let pick: (typeof cls)[number] | null = null, pickWeek1 = '';
      for (const c of cls) {
        const week1 = programWeek1(c.count_to, Number(weeks.find((w) => w.challenge_id === c.challenge_id)?.weeks) || 0);
        if (!week1) continue;
        const week = Math.floor(((dayStart(ride.date) as number) - (dayStart(week1) as number)) / (7 * 86400) + 0.01) + 1;
        if (c.week === week && week1 > pickWeek1) { pick = c; pickWeek1 = week1; }
      }
      const done = !!pick && mine.some((m) => m.class_key === pick!.class_key);
      return {
        ride: { id: ride.id, key: ride.key, label: ride.label, date: ride.date, startsAt: ride.startsAt },
        program: pick ? { id: pick.challenge_id, name: pick.name, week: pick.week } : null,
        class: pick ? { id: pick.peloton_class_id, title: pick.title, instructor: pick.instructor, len: pick.length_min,
                        type: pick.type, done } : null,
        rsvps: rsvps.filter((r) => r.status !== 'out').map((r) => ({ name: r.peloton_username, status: r.status })),
        out: rsvps.filter((r) => r.status === 'out').length,
        mine: rsvps.find((r) => r.rider_id === riderId)?.status || '',
        now: Date.now(),
      };
    },
  };
}
export async function apiGroupRide(db: D1Database, riderId: string, key: string, now = Math.floor(Date.now() / 1000)) {
  const ride = nextGroupRide(key, now);
  const [[riders], data] = await run(db, [
    { queries: [riderQuery(riderId)], build: (rows) => rows as [RiderRow[]] },
    groupRideParts(riderId, ride),
  ] as const);
  requireRider(riders[0]);
  return data;
}
/** In / maybe / out for the current ride only; '' takes the answer back. */
export async function apiGroupRsvp(db: D1Database, riderId: string, key: string, eventId: string, status: string,
                                   now = Math.floor(Date.now() / 1000)) {
  const ride = nextGroupRide(key, now);
  if (eventId !== ride.id) throw new UserError('That ride is over. Refresh for the next one.');
  if (!['in', 'maybe', 'out', ''].includes(status)) throw new UserError('Pick In, Maybe or Out.');
  await requireRiderById(db, riderId);
  const write = status
    ? qb.insertInto('group_rsvps').values({ event_id: ride.id, rider_id: riderId, status, updated_on: new Date(now * 1000).toISOString() })
        .onConflict((oc) => oc.columns(['event_id', 'rider_id']).doUpdateSet({ status, updated_on: new Date(now * 1000).toISOString() }))
    : qb.deleteFrom('group_rsvps').where('event_id', '=', ride.id).where('rider_id', '=', riderId);
  const [, data] = await run(db, [{ queries: [write], build: () => null }, groupRideParts(riderId, ride)] as const);
  return data;
}

// ---------- friends ----------

/** Riders sharing with Everyone whose username contains q, plus an exact username match for anyone. */
export async function apiFriendSearch(db: D1Database, riderId: string, q: unknown) {
  const query = String(q ?? '').trim().toLowerCase();
  if (query.length < 2) return { results: [] as string[] };
  const like = '%' + query.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%';
  const [[riders, results]] = await run(db, [{ queries: [
    riderQuery(riderId),
    // The riders table is short and grows slowly (hundreds of rows); a LIKE scan of it is the
    // documented exception, bounded by LIMIT.
    qb.selectFrom('riders as r').select('r.peloton_username')
      .where('r.status', '=', 'Active').where('r.rider_id', '!=', riderId)
      .where((eb) => eb.not(eb.exists(eb.selectFrom('friends as f').select('f.friend_id')
        .whereRef('f.friend_id', '=', 'r.rider_id').where('f.rider_id', '=', riderId))))
      .where((eb) => eb.or([
        eb(sql`lower(r.peloton_username)`, '=', query),
        eb.and([
          eb.or([eb('r.visibility', '=', 'Everyone'), eb.and([eb('r.visibility', '=', ''), eb('r.buddy_opt_in', '=', 1)])]),
          eb(sql`lower(r.peloton_username)`, 'like', sql`${like} escape '\\'`),
        ]),
      ]))
      .orderBy(sql`lower(r.peloton_username)`).limit(20),
  ], build: (rows) => rows as [RiderRow[], { peloton_username: string }[]] }] as const);
  requireRider(riders[0]);
  return { results: results.map((r) => r.peloton_username) };
}

/** Adds a rider to my friends list by Peloton username. One round trip: look up, insert, read the list. */
export async function apiFriendAdd(db: D1Database, riderId: string, username: unknown) {
  const name = String(username ?? '').trim();
  const [[riders, target, , friends]] = await run(db, [{ queries: [
    riderQuery(riderId),
    qb.selectFrom('riders').select('rider_id').where('status', '=', 'Active').where(sql`peloton_username collate nocase`, '=', name).limit(1),
    qb.insertInto('friends').columns(['rider_id', 'friend_id', 'added_on'])
      .expression(qb.selectFrom('riders').select([sql<string>`${riderId}`.as('rider_id'), 'rider_id as friend_id', sql<string>`${new Date().toISOString()}`.as('added_on')])
        .where('status', '=', 'Active').where(sql`peloton_username collate nocase`, '=', name).where('rider_id', '!=', riderId)
        .where(sql<boolean>`exists (select 1 from riders me where me.rider_id = ${riderId} and me.status = 'Active')`).limit(1))
      .onConflict((oc) => oc.doNothing()),
    friendsQuery(riderId),
  ], build: (rows) => rows as [RiderRow[], { rider_id: string }[], unknown[], FriendListRow[]] }] as const);
  requireRider(riders[0]);
  if (!target.length) throw new UserError('No rider with that Peloton username.');
  if (target[0].rider_id === riderId) throw new UserError("That's you!");
  return { friends: buildFriends(friends) };
}

export async function apiFriendRemove(db: D1Database, riderId: string, username: unknown) {
  const name = String(username ?? '').trim();
  const [[riders, , friends]] = await run(db, [{ queries: [
    riderQuery(riderId),
    qb.deleteFrom('friends').where('rider_id', '=', riderId)
      .where('friend_id', 'in', qb.selectFrom('riders').select('rider_id').where(sql`peloton_username collate nocase`, '=', name)),
    friendsQuery(riderId),
  ], build: (rows) => rows as [RiderRow[], unknown[], FriendListRow[]] }] as const);
  requireRider(riders[0]);
  return { friends: buildFriends(friends) };
}

// ---------- ride graph image ----------

/** Sourdough's ride graph PNG, passed through because his image site doesn't allow other sites to read it. */
export async function apiImage(classId: string, fetcher: typeof fetch = fetch) {
  const res = await fetcher(`https://cdn.sourdoughrides.com/${classId}/full_graph_png.png`);
  if (!res.ok) throw new UserError('No graph for that class.');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > 2_000_000) throw new UserError('That graph is too big.');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { png: btoa(bin) };
}

// ---------- Strava helpers ----------

async function riderAndStrava(db: D1Database, riderId: string): Promise<[RiderRow | undefined, StravaLink | undefined]> {
  const [[r, l]] = await run(db, [{ queries: [riderQuery(riderId), stravaLinkQuery(riderId)],
    build: (rows) => [(rows[0] as RiderRow[])[0], (rows[1] as StravaLink[])[0]] as [RiderRow | undefined, StravaLink | undefined] }] as const);
  return [r, l];
}
async function requireRiderById(db: D1Database, riderId: string) {
  const [[r]] = await run(db, [{ queries: [riderQuery(riderId)], build: (rows) => rows[0] as RiderRow[] }] as const);
  return requireRider(r);
}

// ---------- sign-in methods ----------

export const providerName = (p: string) => ({ discord: 'Discord', reddit: 'Reddit', google: 'Google' } as Record<string, string>)[p] || p;
const identityInsert = (provider: string, subject: string, riderId: string, name: string) =>
  qb.insertInto('identities').values({ provider, subject, rider_id: riderId, name: name.slice(0, 60), added_on: new Date().toISOString() })
    .onConflict((oc) => oc.doNothing());
const identityQuery = (provider: string, subject: string) =>
  qb.selectFrom('identities').select('rider_id').where('provider', '=', provider).where('subject', '=', subject);

/** Proves a sign-in with a provider: Google's ID token, or Discord's one-time code. */
async function proveIdentity(env: RpzEnv, req: Record<string, unknown>, verify: Verify, fetcher: typeof fetch) {
  const provider = String(req.provider || '');
  if (provider === 'google') {
    const u = await verify(req.idToken, env.GOOGLE_CLIENT_ID);
    return { provider: 'google' as Provider, subject: u.sub, name: u.name || '' };
  }
  if (provider === 'discord') {
    const d = await discordIdentity(String(req.code), env, fetcher);
    return { provider: 'discord' as Provider, subject: d.subject, name: d.name };
  }
  throw new UserError('That sign-in method is not available yet.');
}

/** Sign in: the account this identity belongs to (or a new one, by its own id), plus a session. */
export async function apiSignin(db: D1Database, env: RpzEnv, req: Record<string, unknown>, verify: Verify, fetcher: typeof fetch) {
  const id = await proveIdentity(env, req, verify, fetcher);
  const [[known]] = await run(db, [{ queries: [identityQuery(id.provider, id.subject)],
    build: (rows) => rows[0] as { rider_id: string }[] }] as const);
  const who: Who = { ...id, riderId: known?.rider_id || `${id.provider}:${id.subject}` };
  return { session: await signSession(who, env.SESSION_SECRET), who };
}

/** Adds another sign-in method to my account; refuses one that already belongs to someone else. */
export async function apiLink(db: D1Database, env: RpzEnv, who: Who, req: Record<string, unknown>, verify: Verify, fetcher: typeof fetch) {
  const id = await proveIdentity(env, req, verify, fetcher);
  const [[riders, owner]] = await run(db, [{ queries: [
    riderQuery(who.riderId), identityQuery(id.provider, id.subject),
    qb.selectFrom('identities as i').innerJoin('riders as r', 'r.rider_id', 'i.rider_id').select('r.peloton_username')
      .where('i.provider', '=', id.provider).where('i.subject', '=', id.subject),
  ], build: (rows) => [rows[0], rows[2]] as [RiderRow[], { peloton_username: string }[]] }] as const);
  requireRider(riders[0]);
  if (owner[0] && owner[0].peloton_username.toLowerCase() !== riders[0].peloton_username.toLowerCase()) {
    throw new UserError(`That ${providerName(id.provider)} account already signs in to another RedditPZ account (${owner[0].peloton_username}).`);
  }
  const [, me] = await run(db, [{ queries: [identityInsert(id.provider, id.subject, who.riderId, id.name),
    // Discord linked and no Discord name yet: use the account id for buddy posts.
    ...(id.provider === 'discord' ? [qb.updateTable('riders').set({ discord_name: id.subject })
      .where('rider_id', '=', who.riderId).where('discord_name', '=', '')] : [])],
    build: () => null }, meQuery(who.riderId, who)] as const);
  return me;
}

/** Removes a sign-in method, keeping at least one. */
export async function apiUnlink(db: D1Database, who: Who, provider: unknown) {
  const p = String(provider || '');
  const [ids] = await run(db, [{ queries: [qb.selectFrom('identities').select(['provider', 'subject']).where('rider_id', '=', who.riderId).limit(10)],
    build: (rows) => rows[0] as { provider: string; subject: string }[] }] as const);
  if (!ids.some((i) => i.provider === p)) throw new UserError('That sign-in method is not on your account.');
  if (ids.length < 2) throw new UserError('Keep at least one way to sign in.');
  const [, me] = await run(db, [{ queries: [qb.deleteFrom('identities').where('rider_id', '=', who.riderId).where('provider', '=', p)],
    build: () => null }, meQuery(who.riderId, who)] as const);
  return me;
}

// ---------- the calls ----------

export const apiMe = (db: D1Database, riderId: string, user: User) =>
  run(db, [meQuery(riderId, user)] as const).then(([me]) => me);
export const apiProgress = (db: D1Database, riderId: string, challengeId: string, includeRetired: boolean, includePrograms: boolean) =>
  run(db, [progressQuery(riderId, challengeId, includeRetired, includePrograms)] as const).then(([p]) => p);
export const apiBuddies = (db: D1Database, riderId: string, challengeId: string, selected: string[], includePrograms: boolean) =>
  run(db, [buddiesQuery(riderId, challengeId, selected, includePrograms)] as const).then(([b]) => b);

/**
 * Startup: profile, plus progress and buddies for the challenge the page will show first, in one
 * round trip when the page's remembered challenge is still shown (the usual case); otherwise a
 * second trip for the first shown challenge.
 */
export async function apiBoot(db: D1Database, riderId: string, user: User, wanted: string | null) {
  const guess = wanted && ID_RE.test(wanted) ? wanted : null;
  if (guess) {
    const [me, progress, buddies] = await run(db, [meQuery(riderId, user),
      softly(progressQuery(riderId, guess, true, true)), softly(buddiesQuery(riderId, guess, [], true))] as const);
    if (!me.rider) return { me };
    if (shownIds(me).includes(guess) && progress && buddies) return { me, challengeId: guess, progress, buddies };
    return bootFor(db, riderId, me);
  }
  const me = await apiMe(db, riderId, user);
  return me.rider ? bootFor(db, riderId, me) : { me };
}
function shownIds(me: ReturnType<typeof buildMe>): string[] {
  const shown = me.challenges.filter((c) => !c.hidden);
  return (shown.length ? shown : me.challenges).map((c) => c.id);
}
async function bootFor(db: D1Database, riderId: string, me: ReturnType<typeof buildMe>) {
  const id = shownIds(me)[0];
  if (!id) return { me };
  const [progress, buddies] = await run(db, [progressQuery(riderId, id, true, true), buddiesQuery(riderId, id, [], true)] as const);
  return { me, challengeId: id, progress, buddies };
}
/** A part whose build returns null instead of throwing (e.g. a remembered challenge that's gone). */
function softly<T>(p: Part<T>): Part<T | null> {
  return { queries: p.queries, build: (rows) => { try { return p.build(rows); } catch (e) { if (e instanceof UserError) return null; throw e; } } };
}

// ---------- the route ----------

export function rpzApi(verify: Verify = verifyGoogleIdToken, fetcher: typeof fetch = fetch) {
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
    const meter: Meter = { trips: 0, read: 0, written: 0 };
    let req: Record<string, unknown>;
    try { req = await c.req.json(); } catch { return c.json({ ok: false, error: 'Bad request.' }, 400); }
    const action = String(req.action || '');
    // Bad input gets a 400 before any database work.
    if (!ACTIONS.has(action)) return c.json({ ok: false, error: 'Unknown request.' }, 400);
    const challengeId = String(req.challengeId || '');
    if (['progress', 'buddies', 'toggleManual'].includes(action) && !ID_RE.test(challengeId)) {
      return c.json({ ok: false, error: 'Bad challenge.' }, 400);
    }
    if ((action === 'toggleManual' && !CLASS_RE.test(String(req.classId || ''))) ||
        (action === 'image' && !CLASS_RE.test(String(req.id || '')))) {
      return c.json({ ok: false, error: 'Unknown class.' }, 400);
    }
    if (['friendSearch', 'friendAdd', 'friendRemove'].includes(action) &&
        String(req.q ?? req.username ?? '').length > 40) {
      return c.json({ ok: false, error: 'Too long.' }, 400);
    }
    if (action === 'sync' && (typeof req.csvText !== 'string' || req.csvText.length > MAX_CSV)) {
      return c.json({ ok: false, error: 'That file is too big or not a CSV.' }, 400);
    }
    const selected = Array.isArray(req.buddies) ? req.buddies.map(String) : (req.buddy ? [String(req.buddy)] : []);
    if (selected.length > 50 || !selected.every((u) => USERNAME_RE.test(u))) {
      return c.json({ ok: false, error: 'Bad rider list.' }, 400);
    }
    if (['signin', 'link'].includes(action) && !(
        (req.provider === 'google' && typeof req.idToken === 'string' && req.idToken.length < 4096) ||
        (req.provider === 'discord' && /^[A-Za-z0-9]{10,100}$/.test(String(req.code || ''))))) {
      return c.json({ ok: false, error: 'Bad sign-in.' }, 400);
    }
    try {
      const db = metered(c.env.RPZ_DB, meter);
      if (action === 'signin') {
        const { session, who } = await apiSignin(db, c.env, req, verify, fetcher);
        const boot = await apiBoot(db, who.riderId, who, challengeId || null);
        return c.json({ ok: true, data: { session, ...boot }, ms: Date.now() - t0, d1: meter });
      }
      // A RedditPZ session ("rpz1."), or (older pages) a Google ID token.
      const token = String(req.token || '');
      let user: Who;
      if (token.startsWith('rpz1.')) user = await verifySession(token, c.env.SESSION_SECRET);
      else {
        const g = await verify(req.token, c.env.GOOGLE_CLIENT_ID);
        user = { provider: 'google', subject: g.sub, name: g.name, riderId: 'google:' + g.sub };
      }
      const authMs = Date.now() - t0;
      const riderId = user.riderId;
      const programs = req.includePrograms !== false;
      let data: unknown;
      switch (action) {
        case 'boot': data = await apiBoot(db, riderId, user, challengeId || null);
          // Each visit renews the session, so riders who keep using the app stay signed in.
          if (token.startsWith('rpz1.')) data = { session: await signSession(user, c.env.SESSION_SECRET), ...(data as object) };
          break;
        case 'link': data = await apiLink(db, c.env, user, req, verify, fetcher); break;
        case 'unlink': data = await apiUnlink(db, user, req.provider); break;
        case 'me': data = await apiMe(db, riderId, user); break;
        case 'progress': data = await apiProgress(db, riderId, challengeId, !!req.includeRetired, programs); break;
        case 'buddies': data = await apiBuddies(db, riderId, challengeId, selected, programs); break;
        case 'sync': data = await apiSync(db, riderId, user, req.csvText as string); break;
        case 'join': data = await apiJoin(db, riderId, user, req.pelotonUsername, req.discordName); break;
        case 'settings': data = await apiSettings(db, riderId, user, req.discordName,
          req.visibility || (req.buddyOptIn ? 'Everyone' : 'Nobody')); break;
        case 'challengeView': data = await apiChallengeView(db, riderId, user, req.hidden); break;
        case 'toggleManual': data = await apiToggleManual(db, riderId, challengeId, String(req.classId)); break;
        case 'friendSearch': data = await apiFriendSearch(db, riderId, req.q); break;
        case 'friendAdd': data = await apiFriendAdd(db, riderId, req.username); break;
        case 'friendRemove': data = await apiFriendRemove(db, riderId, req.username); break;
        case 'image': data = await apiImage(String(req.id)); break;
        case 'groupRide': data = await apiGroupRide(db, riderId, String(req.key || 'sat')); break;
        case 'groupRsvp': data = await apiGroupRsvp(db, riderId, String(req.key || 'sat'), String(req.eventId || ''), String(req.status || '')); break;
        case 'stravaConnect': {
          if (typeof req.code !== 'string' || !/^[A-Za-z0-9]{10,100}$/.test(req.code)) throw new UserError('Missing Strava code.');
          await requireRiderById(db, riderId);
          await stravaConnect(db, c.env, riderId, req.code);
          data = await apiMe(db, riderId, user);
          break;
        }
        case 'stravaDisconnect': {
          const [rider, link] = await riderAndStrava(db, riderId);
          requireRider(rider);
          await stravaDisconnect(db, link);
          data = await apiMe(db, riderId, user);
          break;
        }
        case 'power': {
          const [rider, link] = await riderAndStrava(db, riderId);
          requireRider(rider);
          data = await stravaPower(db, c.env, link, Number(req.rodeAt) || 0, Math.min(240, Number(req.lengthMin) || 0));
          break;
        }
      }
      return c.json({ ok: true, data, ms: Date.now() - t0, authMs, d1: meter });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const known = err instanceof UserError || /^(SIGNIN_|Please sign in)/.test(msg);
      if (!known) console.error('rpz api', action, msg);   // log errors only, never successes
      return c.json({ ok: false, error: known ? msg : 'Something went wrong.', ms: Date.now() - t0 });
    }
  });

  return app;
}
