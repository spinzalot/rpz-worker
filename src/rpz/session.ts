// Sessions: after any sign-in (Google, Discord, later Reddit) the Worker issues its own signed token, so
// the page needn't keep a provider token and every request is checked with one HMAC (no D1, no fetch).
// Token: "rpz1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256). Secret: SESSION_SECRET.
import { UserError } from './errors';

export type Provider = 'google' | 'discord' | 'reddit';
export const PROVIDERS: Provider[] = ['discord', 'reddit', 'google'];
export interface Who { provider: Provider; subject: string; name: string; riderId: string }

export const SESSION_DAYS = 90;
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

const keys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string) {
  if (!keys.has(secret)) keys.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  return keys.get(secret)!;
}
function needSecret(secret: string | undefined): string {
  if (!secret || secret.length < 32) throw new UserError('Sign-in is not set up yet (missing SESSION_SECRET).');
  return secret;
}

export async function signSession(who: Who, secret: string | undefined, now = Date.now()): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify({ p: who.provider, s: who.subject, n: who.name, r: who.riderId,
    e: Math.floor(now / 1000) + SESSION_DAYS * 86400 })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(needSecret(secret)), enc.encode(body)));
  return 'rpz1.' + body + '.' + b64u(sig);
}

export async function verifySession(token: string, secret: string | undefined, now = Date.now()): Promise<Who> {
  const [, body, sig] = token.split('.');
  if (!body || !sig) throw new Error('Please sign in.');
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(needSecret(secret)), unb64u(sig), enc.encode(body)); } catch { ok = false; }
  if (!ok) throw new Error('Please sign in.');
  const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
  if (!(p.e > now / 1000)) throw new Error('SIGNIN_EXPIRED');
  if (!PROVIDERS.includes(p.p) || typeof p.s !== 'string' || typeof p.r !== 'string') throw new Error('Please sign in.');
  return { provider: p.p, subject: p.s, name: String(p.n || ''), riderId: p.r };
}

/** Discord: trade the one-time code from Discord's approval page for the account's id and name. */
export async function discordIdentity(code: string, env: { DISCORD_CLIENT_ID?: string; DISCORD_CLIENT_SECRET?: string; DISCORD_REDIRECT_URI?: string },
                                      fetcher: typeof fetch = fetch): Promise<{ subject: string; name: string; username: string }> {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.DISCORD_REDIRECT_URI) {
    throw new UserError('Discord sign-in is not set up yet.');
  }
  const tok = await fetcher('https://discord.com/api/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code', code, redirect_uri: env.DISCORD_REDIRECT_URI }),
  });
  if (!tok.ok) throw new UserError('Discord sign-in failed. Please try again.');
  const { access_token } = await tok.json<{ access_token: string }>();
  const res = await fetcher('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + access_token } });
  if (!res.ok) throw new UserError('Discord sign-in failed. Please try again.');
  const u = await res.json<{ id: string; username: string; global_name?: string | null }>();
  if (!/^\d{5,25}$/.test(String(u.id))) throw new UserError('Discord sign-in failed. Please try again.');
  return { subject: String(u.id), name: u.global_name || u.username, username: u.username };
}
