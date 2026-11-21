import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { apiJoin, apiSettings, apiChallengeView, apiToggleManual, apiFriendSearch, apiFriendAdd, apiFriendRemove,
  apiImage, apiMe, apiProgress, rpzApi, type RpzEnv } from '../../src/rpz/api';
import { seed, ME, BUDDY, HIDDEN } from './fixture';

const e = env as unknown as RpzEnv;
const user = { sub: '111', email: 'me@example.com', name: 'Jim' };

function counting(db: D1Database) {
  let trips = 0;
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') return (s: D1PreparedStatement[]) => { trips++; return target.batch(s); };
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db: wrapped as D1Database, trips: () => trips };
}

beforeAll(async () => {
  await seed(e.RPZ_DB);
  // A rider synced before sign-in existed: placeholder id, no email, one ride.
  await e.RPZ_DB.batch([
    e.RPZ_DB.prepare(`insert into riders (rider_id,email,peloton_username,status) values ('peloton:OldTimer','','OldTimer','Active')`),
    e.RPZ_DB.prepare(`insert into completions (rider_id,ridden_at,class_key) values ('peloton:OldTimer',1700000000,'k')`),
  ]);
});

describe('settings', () => {
  it('saves Discord ID and visibility, returning the fresh profile in one round trip', async () => {
    const c = counting(e.RPZ_DB);
    const me = await apiSettings(c.db, ME, user, '@1234567890', 'Friends');
    expect(c.trips()).toBe(1);
    expect(me.rider).toMatchObject({ discordName: '1234567890', visibility: 'Friends' });
  });
  it('treats an unknown visibility as Nobody', async () => {
    expect((await apiSettings(e.RPZ_DB, ME, user, '', 'Sometimes')).rider!.visibility).toBe('Nobody');
    await apiSettings(e.RPZ_DB, ME, user, '', 'Everyone');
  });
  it('refuses someone who has not joined', async () => {
    await expect(apiSettings(e.RPZ_DB, 'google:999', { ...user, sub: '999' }, '', 'Everyone')).rejects.toThrow(/join first/);
  });
});

describe('challenge view', () => {
  it('stores only departures from the defaults and keeps at least one challenge', async () => {
    const me = await apiChallengeView(e.RPZ_DB, ME, user, ['P29', 'OLD']);
    expect(me.challenges.filter((c) => c.hidden).map((c) => c.id).sort()).toEqual(['OLD', 'P29']);
    const row = await e.RPZ_DB.prepare('select challenge_view from riders where rider_id = ?').bind(ME).first<{ challenge_view: string }>();
    expect(row!.challenge_view).toBe('-P29');   // OLD is hidden by default: nothing stored for it
    await expect(apiChallengeView(e.RPZ_DB, ME, user, ['CW-PZ', 'P29', 'OLD'])).rejects.toThrow(/at least one/);
  });
});

describe('manual checks', () => {
  it('toggles a gray check on and off and counts it in progress', async () => {
    const before = (await apiProgress(e.RPZ_DB, ME, 'P29', false, true)).done;
    expect(await apiToggleManual(e.RPZ_DB, ME, 'P29', 'p2')).toEqual({ manual: true });
    expect((await apiProgress(e.RPZ_DB, ME, 'P29', false, true)).done).toBe(before + 1);
    expect(await apiToggleManual(e.RPZ_DB, ME, 'P29', 'p2')).toEqual({ manual: false });
    expect((await apiProgress(e.RPZ_DB, ME, 'P29', false, true)).done).toBe(before);
  });
  it('refuses a class that is not in the challenge', async () => {
    await expect(apiToggleManual(e.RPZ_DB, ME, 'P29', 'b1')).rejects.toThrow(/Unknown class/);
  });
});

describe('friends', () => {
  it('finds partial matches only among riders sharing with Everyone, and exact names for anyone', async () => {
    expect((await apiFriendSearch(e.RPZ_DB, HIDDEN, 'spin')).results).toEqual(['spinzalot']);  // Everyone
    expect((await apiFriendSearch(e.RPZ_DB, BUDDY, 'spin')).results).toEqual([]);              // already on their list
    expect((await apiFriendSearch(e.RPZ_DB, BUDDY, 'herm')).results).toEqual([]);              // Nobody: partial hidden
    expect((await apiFriendSearch(e.RPZ_DB, BUDDY, 'hermit')).results).toEqual(['Hermit']);    // exact always works
    expect((await apiFriendSearch(e.RPZ_DB, ME, 'thefinder')).results).toEqual([]);            // already on my list
    expect((await apiFriendSearch(e.RPZ_DB, ME, '%')).results).toEqual([]);                     // too short
    expect((await apiFriendSearch(e.RPZ_DB, ME, '%_')).results).toEqual([]);                    // wildcards are literal
  });
  it('adds and removes by username in one round trip each', async () => {
    const c = counting(e.RPZ_DB);
    const added = await apiFriendAdd(c.db, ME, 'hermit');
    expect(c.trips()).toBe(1);
    expect(added.friends).toEqual([{ username: 'Hermit', sharing: false }, { username: 'TheFinder', sharing: true }]);
    const again = await apiFriendAdd(e.RPZ_DB, ME, 'Hermit');   // no duplicate
    expect(again.friends).toHaveLength(2);
    expect((await apiFriendRemove(e.RPZ_DB, ME, 'Hermit')).friends).toEqual([{ username: 'TheFinder', sharing: true }]);
  });
  it('explains a missing rider or adding yourself', async () => {
    await expect(apiFriendAdd(e.RPZ_DB, ME, 'nobody-here')).rejects.toThrow(/No rider/);
    await expect(apiFriendAdd(e.RPZ_DB, ME, 'SpinZalot')).rejects.toThrow(/That's you/);
  });
});

describe('join', () => {
  it('creates a new rider', async () => {
    const me = await apiJoin(e.RPZ_DB, 'google:444', { sub: '444', email: 'n@example.com', name: '' }, 'NewRider', 'nr');
    expect(me.rider).toMatchObject({ pelotonUsername: 'NewRider', discordName: 'nr', visibility: 'Nobody' });
  });
  it('claims history synced before sign-in existed', async () => {
    const me = await apiJoin(e.RPZ_DB, 'google:555', { sub: '555', email: 'o@example.com', name: '' }, 'oldtimer', '');
    expect(me.rider).toMatchObject({ pelotonUsername: 'OldTimer', lastRideAt: 1700000000 });
  });
  it('refuses a username already linked to another account, and bad usernames', async () => {
    await expect(apiJoin(e.RPZ_DB, 'google:666', { sub: '666', email: '', name: '' }, 'TheFinder', '')).rejects.toThrow(/already linked/);
    await expect(apiJoin(e.RPZ_DB, 'google:666', { sub: '666', email: '', name: '' }, 'x y', '')).rejects.toThrow(/exactly as it appears/);
  });
  it('updates only the Discord ID for someone who already joined', async () => {
    const me = await apiJoin(e.RPZ_DB, ME, user, 'ignored', 'newdiscord');
    expect(me.rider).toMatchObject({ pelotonUsername: 'spinzalot', discordName: 'newdiscord' });
  });
});

describe('image', () => {
  it('passes the PNG through as base64', async () => {
    const fake = (async () => new Response(new Uint8Array([137, 80, 78, 71]))) as unknown as typeof fetch;
    expect(await apiImage('0123456789abcdef0123456789abcdef', fake)).toEqual({ png: 'iVBORw==' });
  });
});

describe('route validation', () => {
  const app = rpzApi(async () => user);
  const post = (body: unknown) => app.request('/', { method: 'POST', body: JSON.stringify(body) }, e);
  it('rejects malformed ids before any work', async () => {
    expect((await post({ token: 't', action: 'toggleManual', challengeId: 'P29', classId: 'nope' })).status).toBe(400);
    expect((await post({ token: 't', action: 'image', id: '../etc' })).status).toBe(400);
    expect((await post({ token: 't', action: 'friendAdd', username: 'x'.repeat(41) })).status).toBe(400);
  });
});

it('the rider list still reads back cleanly after all of that', async () => {
  const me = await apiMe(e.RPZ_DB, HIDDEN, { ...user, sub: '333' });
  expect(me.rider!.pelotonUsername).toBe('Hermit');
});

it('reports what each request cost in D1', async () => {
  const app = rpzApi(async () => user);
  const res = await app.request('/', { method: 'POST', body: JSON.stringify({ token: 't', action: 'me' }) }, e);
  const j = await res.json<{ d1: { trips: number; read: number; written: number } }>();
  expect(j.d1.trips).toBe(1);
  expect(j.d1.read).toBeGreaterThan(0);
  expect(j.d1.written).toBe(0);
});
