import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { stravaConnect, stravaDisconnect, stravaPower, stravaLinkQuery, type StravaLink } from '../../src/rpz/strava';
import { apiMe, type RpzEnv } from '../../src/rpz/api';
import { seed, ME } from './fixture';

const e = env as unknown as RpzEnv;
const senv = { STRAVA_CLIENT_ID: '298650', STRAVA_CLIENT_SECRET: 'test-secret' };
const user = { sub: '111', email: 'me@example.com', name: 'Jim' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const link = async () => {
  const c = stravaLinkQuery(ME).compile();
  return (await e.RPZ_DB.prepare(c.sql).bind(...(c.parameters as unknown[])).first<StravaLink>()) ?? undefined;
};

beforeAll(() => seed(e.RPZ_DB));

describe('strava', () => {
  it('connects, storing the sign-in and FTP, and shows as connected', async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/oauth/token')) {
        expect(String(init!.body)).toContain('client_secret=test-secret');
        return json({ access_token: 'A1', refresh_token: 'R1', expires_at: 9e9, athlete: { id: 7, firstname: 'Jim', lastname: 'S' } });
      }
      return json({ ftp: 250 });
    }) as unknown as typeof fetch;
    await stravaConnect(e.RPZ_DB, senv, ME, 'abcdef123456', fake);
    expect(calls).toHaveLength(2);
    expect((await apiMe(e.RPZ_DB, ME, user)).rider!.strava).toEqual({ connected: true, name: 'Jim S', ftp: 250 });
  });

  it('refreshes an expiring sign-in, then returns power on a 1-second grid', async () => {
    await e.RPZ_DB.prepare('update strava_links set expires_at = 0 where rider_id = ?').bind(ME).run();
    const rodeAt = 1_763_000_000;
    const fake = (async (url: string) => {
      if (url.endsWith('/oauth/token')) return json({ access_token: 'A2', refresh_token: 'R2', expires_at: 9e9 });
      if (url.includes('/athlete/activities')) return json([
        { id: 1, name: 'Far', start_date: new Date((rodeAt + 1500) * 1000).toISOString() },
        { id: 2, name: 'Near', start_date: new Date((rodeAt + 30) * 1000).toISOString(), average_watts: 201.4, average_cadence: 85, has_heartrate: false },
      ]);
      expect(url).toContain('/activities/2/streams');
      return json({ time: { data: [0, 1, 3] }, watts: { data: [100, 110, 130] } });
    }) as unknown as typeof fetch;
    const p = await stravaPower(e.RPZ_DB, senv, await link(), rodeAt, 0, fake);
    expect(p).toMatchObject({ name: 'Near', avgWatts: 201, cadence: 85, hr: 0, ftp: 250, watts: [100, 110, 110, 130] });
    expect((await link())!.access).toBe('A2');
  });

  it('explains a missing activity and a removed sign-in', async () => {
    await expect(stravaPower(e.RPZ_DB, senv, await link(), 1_763_000_000, 45, (async () => json([])) as unknown as typeof fetch))
      .rejects.toThrow(/No Strava activity/);
    await expect(stravaPower(e.RPZ_DB, senv, await link(), 1_763_000_000, 45, (async () => json({}, 401)) as unknown as typeof fetch))
      .rejects.toThrow(/Connect Strava again/);
    await expect(stravaPower(e.RPZ_DB, senv, undefined, 1, 45)).rejects.toThrow(/Connect Strava first/);
  });

  it('disconnects and forgets the sign-in', async () => {
    await stravaDisconnect(e.RPZ_DB, await link(), (async () => json({})) as unknown as typeof fetch);
    expect(await link()).toBeUndefined();
    expect((await apiMe(e.RPZ_DB, ME, user)).rider!.strava).toEqual({ connected: false });
  });

  it('refuses to connect without the secret configured', async () => {
    await expect(stravaConnect(e.RPZ_DB, { STRAVA_CLIENT_ID: '1' }, ME, 'abcdef123456')).rejects.toThrow(/not set up/);
  });
});
