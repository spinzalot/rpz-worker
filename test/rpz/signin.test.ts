import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { rpzApi, type RpzEnv } from '../../src/rpz/api';
import { signSession, verifySession } from '../../src/rpz/session';
import { seed, ME } from './fixture';

const e = env as unknown as RpzEnv;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
// Google: the fake verifier turns "g:<sub>" into a Google account. Discord: a fake API for code "code<id>".
const verify = async (t: unknown) => { const sub = String(t).replace(/^g:/, ''); return { sub, email: '', name: 'G ' + sub }; };
const fakeDiscord = (async (url: string, init?: RequestInit) => {
  if (url.endsWith('/oauth2/token')) return json({ access_token: 'at-' + new URLSearchParams(String(init!.body)).get('code') });
  const code = String((init!.headers as Record<string, string>).Authorization).replace('Bearer at-code', '');
  return json({ id: code, username: 'user' + code, global_name: 'Disc ' + code });
}) as unknown as typeof fetch;
const app = rpzApi(verify, fakeDiscord);
const call = async (body: Record<string, unknown>) => (await app.request('/', { method: 'POST', body: JSON.stringify(body) }, e)).json<any>();

beforeAll(async () => {
  await seed(e.RPZ_DB);
  await e.RPZ_DB.prepare(`insert into identities (provider,subject,rider_id) values ('google','111',?)`).bind(ME).run();
});

describe('sessions', () => {
  it('round-trips and rejects tampering and expiry', async () => {
    const who = { provider: 'discord' as const, subject: '42', name: 'X', riderId: 'discord:42' };
    const t = await signSession(who, e.SESSION_SECRET);
    expect(await verifySession(t, e.SESSION_SECRET)).toEqual(who);
    await expect(verifySession(t.slice(0, -2) + 'xx', e.SESSION_SECRET)).rejects.toThrow(/sign in/);
    await expect(verifySession(t, e.SESSION_SECRET, Date.now() + 91 * 86400e3)).rejects.toThrow('SIGNIN_EXPIRED');
  });
});

describe('sign-in', () => {
  it('Google sign-in finds the existing account and returns a session and the profile', async () => {
    const r = await call({ action: 'signin', provider: 'google', idToken: 'g:111' });
    expect(r.ok).toBe(true);
    expect(r.data.session).toMatch(/^rpz1\./);
    expect(r.data.me.rider.pelotonUsername).toBe('spinzalot');
    expect(r.data.me.signins).toEqual([{ provider: 'google', name: '' }]);
    // The session works for later calls, and boot renews it.
    const b = await call({ action: 'boot', token: r.data.session });
    expect(b.data.me.rider.pelotonUsername).toBe('spinzalot');
    expect(b.data.session).toMatch(/^rpz1\./);
  });

  it('a new Discord rider joins with their Discord id filled in, and can sign in again', async () => {
    const s = (await call({ action: 'signin', provider: 'discord', code: 'code777000' })).data;
    expect(s.me.rider).toBeNull();
    const j = await call({ action: 'join', token: s.session, pelotonUsername: 'NewDiscordRider' });
    expect(j.data.rider).toMatchObject({ pelotonUsername: 'NewDiscordRider', discordName: '777000' });
    expect(j.data.signins).toEqual([{ provider: 'discord', name: 'Disc 777000' }]);
    const again = (await call({ action: 'signin', provider: 'discord', code: 'code777000' })).data;
    expect(again.me.rider.pelotonUsername).toBe('NewDiscordRider');
  });

  it('joining with a taken username says how that account signs in', async () => {
    const s = (await call({ action: 'signin', provider: 'discord', code: 'code888000' })).data;
    const j = await call({ action: 'join', token: s.session, pelotonUsername: 'spinzalot' });
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/spinzalot is already registered\. Sign in with Google/);
  });

  it('links Discord to my account, refuses one owned by someone else, and unlinks', async () => {
    const mine = (await call({ action: 'signin', provider: 'google', idToken: 'g:111' })).data.session;
    const linked = await call({ action: 'link', token: mine, provider: 'discord', code: 'code555000' });
    expect(linked.data.signins.map((x: any) => x.provider)).toEqual(['discord', 'google']);
    // Now Discord sign-in lands on the same account.
    expect((await call({ action: 'signin', provider: 'discord', code: 'code555000' })).data.me.rider.pelotonUsername).toBe('spinzalot');
    const taken = await call({ action: 'link', token: mine, provider: 'discord', code: 'code777000' });
    expect(taken.error).toMatch(/already signs in to another RedditPZ account \(NewDiscordRider\)/);
    const un = await call({ action: 'unlink', token: mine, provider: 'discord' });
    expect(un.data.signins.map((x: any) => x.provider)).toEqual(['google']);
    expect((await call({ action: 'unlink', token: mine, provider: 'google' })).error).toMatch(/at least one/);
  });

  it('older pages that send a Google ID token still work', async () => {
    expect((await call({ action: 'me', token: 'g:111' })).data.rider.pelotonUsername).toBe('spinzalot');
  });

  it('rejects a malformed sign-in before any work', async () => {
    const r = await app.request('/', { method: 'POST', body: JSON.stringify({ action: 'signin', provider: 'discord', code: 'x' }) }, e);
    expect(r.status).toBe(400);
  });
});
