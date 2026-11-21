import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { apiMe, apiProgress, rpzApi, type RpzEnv } from '../../src/rpz/api';
import { seed, ME } from './fixture';

const e = env as unknown as RpzEnv;

/** Wraps the D1 binding to count round trips (each batch or single statement run is one). */
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

const user = { sub: '111', email: 'me@example.com', name: 'Jim' };
const fakeVerify = async (token: unknown) => {
  if (token !== 'good') throw new Error('SIGNIN_EXPIRED');
  return user;
};

beforeAll(async () => { await seed(e.RPZ_DB); });

describe('me', () => {
  it('returns profile, friends, challenges and grid order in one round trip', async () => {
    const c = counting(e.RPZ_DB);
    const me = await apiMe(c.db, ME, user);
    expect(c.trips()).toBe(1);
    expect(me.rider).toMatchObject({ pelotonUsername: 'spinzalot', visibility: 'Everyone', lastRideAt: 1794000000 });
    expect(me.friends).toEqual([{ username: 'TheFinder', sharing: true }]);
    const p29 = me.challenges.find((x) => x.id === 'P29')!;
    expect(p29.week1).toBe('2026-11-09');
    expect(me.challenges.find((x) => x.id === 'OLD')!.hidden).toBe(false);   // hidden by default, shown by +OLD
    expect(me.typeOrder).toEqual(['PZR', 'PZE', 'PZ']);
  });

  it('a new visitor gets no rider and no friends', async () => {
    const me = await apiMe(e.RPZ_DB, 'google:999', { sub: '999', email: 'x@example.com', name: '' });
    expect(me.rider).toBeNull();
    expect(me.friends).toEqual([]);
  });
});

describe('progress', () => {
  it('credits twin classes one per ride, counts manual marks, hides retired and Other', async () => {
    const c = counting(e.RPZ_DB);
    const p = await apiProgress(c.db, ME, 'CW-PZ', false, true);
    expect(c.trips()).toBe(1);
    expect(p.total).toBe(3);
    expect(p.done).toBe(2);
    const byId = Object.fromEntries(p.classes.map((x) => [x.id, x]));
    expect(byId.a1.done).toBe(true);
    expect(byId.a2.done).toBe(false);
    expect(byId.b1).toMatchObject({ done: true, manual: true });
    expect(byId.x1).toBeUndefined();
  });

  it('shows retired classes only when done and asked for', async () => {
    const p = await apiProgress(e.RPZ_DB, ME, 'CW-PZ', true, true);
    expect(p.total).toBe(4);
    expect(p.done).toBe(3);
  });

  it('can leave out program classes', async () => {
    const p = await apiProgress(e.RPZ_DB, ME, 'CW-PZ', false, false);
    expect(p.total).toBe(1);
  });

  it('only counts rides inside a program\'s count window', async () => {
    const p = await apiProgress(e.RPZ_DB, ME, 'P29', false, true);
    expect(p.total).toBe(2);
    expect(p.done).toBe(1);
    expect(p.classes.find((x) => x.id === 'p1')).toMatchObject({ done: true, week: 1, slot: 'Mon', rodeAt: 1794000000 });
  });
});

describe('the route', () => {
  const app = rpzApi(fakeVerify);
  const post = (body: unknown, db = e.RPZ_DB) =>
    app.request('/', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: 'https://spinzalot.github.io' } },
      { ...e, RPZ_DB: db });

  it('rejects bad input with 400 and no database work', async () => {
    const c = counting(e.RPZ_DB);
    expect((await post({ token: 'good', action: 'drop tables' }, c.db)).status).toBe(400);
    expect((await post({ token: 'good', action: 'progress', challengeId: "x'; --" }, c.db)).status).toBe(400);
    expect(c.trips()).toBe(0);
  });

  it('turns an expired sign-in into SIGNIN_EXPIRED for the page', async () => {
    const res = await (await post({ token: 'bad', action: 'me' })).json() as { ok: boolean; error: string };
    expect(res).toMatchObject({ ok: false, error: 'SIGNIN_EXPIRED' });
  });

  it('answers the page in the Apps Script shape, with CORS for the allowed origin', async () => {
    const res = await post({ token: 'good', action: 'progress', challengeId: 'CW-PZ' });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://spinzalot.github.io');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json() as { ok: boolean; data: { total: number }; ms: number };
    expect(body.ok).toBe(true);
    expect(body.data.total).toBe(3);   // includeRetired defaults off, like the Apps Script version
    expect(typeof body.ms).toBe('number');
  });

  it('is off when the flag is off', async () => {
    const res = await app.request('/', { method: 'POST', body: '{}' }, { ...e, RPZ_ENABLED: 'false' });
    expect(res.status).toBe(404);
  });
});
