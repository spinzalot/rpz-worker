// Strava: each rider's own power trace for a class they've done, to draw over the class graph.
// Port of the Apps Script Strava.gs. Sign-ins live in strava_links; the client secret is a Worker
// secret (wrangler secret put STRAVA_CLIENT_SECRET). Nothing from a rider's Strava is shown to anyone else.
import { qb } from './db';
import { UserError } from './errors';

export interface StravaEnv { STRAVA_CLIENT_ID: string; STRAVA_CLIENT_SECRET?: string }
export interface StravaLink { rider_id: string; athlete_id: number | null; name: string; ftp: number; access: string; refresh: string; expires_at: number }

export const stravaLinkQuery = (riderId: string) => qb.selectFrom('strava_links').selectAll().where('rider_id', '=', riderId);
export const stravaStatus = (link: StravaLink | undefined) =>
  link ? { connected: true, name: link.name || '', ftp: link.ftp || 0 } : { connected: false };

async function token(env: StravaEnv, params: Record<string, string>, fetcher: typeof fetch) {
  if (!env.STRAVA_CLIENT_SECRET) throw new UserError('Strava is not set up yet (missing STRAVA_CLIENT_SECRET).');
  const res = await fetcher('https://www.strava.com/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({ ...params, client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET }),
  });
  const body = await res.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) throw new UserError('Strava sign-in failed: ' + (body.message || res.status));
  return body as { access_token: string; refresh_token: string; expires_at: number; athlete?: { id: number; firstname?: string; lastname?: string } };
}

/** The page sends the code Strava returned after the rider approved access. */
export async function stravaConnect(db: D1Database, env: StravaEnv, riderId: string, code: string, fetcher: typeof fetch = fetch) {
  const t = await token(env, { code, grant_type: 'authorization_code' }, fetcher);
  const a = t.athlete || { id: 0 };
  let ftp = 0;
  try {   // FTP from the Strava profile (needs profile:read_all); optional
    const res = await fetcher('https://www.strava.com/api/v3/athlete', { headers: { Authorization: 'Bearer ' + t.access_token } });
    if (res.ok) ftp = Number((await res.json<{ ftp?: number }>()).ftp) || 0;
  } catch { /* keep 0 */ }
  const row = { rider_id: riderId, athlete_id: a.id || null, name: [a.firstname, a.lastname].filter(Boolean).join(' '), ftp,
    access: t.access_token, refresh: t.refresh_token, expires_at: Number(t.expires_at) };
  const c = qb.insertInto('strava_links').values(row)
    .onConflict((oc) => oc.column('rider_id').doUpdateSet(row)).compile();
  await db.batch([db.prepare(c.sql).bind(...(c.parameters as unknown[]))]);
}

export async function stravaDisconnect(db: D1Database, link: StravaLink | undefined, fetcher: typeof fetch = fetch) {
  if (!link) return;
  try {   // Strava retires /oauth/deauthorize on 2027-06-01: switch to its replacement before then
    await fetcher('https://www.strava.com/oauth/deauthorize', { method: 'POST', body: new URLSearchParams({ access_token: link.access }) });
  } catch { /* forget it here regardless */ }
  const c = qb.deleteFrom('strava_links').where('rider_id', '=', link.rider_id).compile();
  await db.batch([db.prepare(c.sql).bind(...(c.parameters as unknown[]))]);
}

/** GET from the Strava API as this rider, refreshing the sign-in when it's about to expire. */
async function stravaGet<T>(db: D1Database, env: StravaEnv, link: StravaLink, path: string, fetcher: typeof fetch): Promise<T> {
  if (link.expires_at - 300 < Date.now() / 1000) {
    const t = await token(env, { refresh_token: link.refresh, grant_type: 'refresh_token' }, fetcher);
    Object.assign(link, { access: t.access_token, refresh: t.refresh_token, expires_at: Number(t.expires_at) });
    const c = qb.updateTable('strava_links').set({ access: link.access, refresh: link.refresh, expires_at: link.expires_at })
      .where('rider_id', '=', link.rider_id).compile();
    await db.batch([db.prepare(c.sql).bind(...(c.parameters as unknown[]))]);
  }
  const res = await fetcher('https://www.strava.com/api/v3' + path, { headers: { Authorization: 'Bearer ' + link.access } });
  if (res.status === 401) throw new UserError('Strava access was removed. Connect Strava again in Settings ⚙.');
  if (res.status === 429) throw new UserError('Strava is busy (too many requests). Try again in 15 minutes.');
  if (!res.ok) throw new UserError('Strava error ' + res.status + '.');
  return res.json<T>();
}

/**
 * Power for the ride that started at rodeAt (epoch seconds, from my stored rides): the Strava
 * activity that started closest to it (within 30 minutes), as watts on a one-per-second grid.
 */
export async function stravaPower(db: D1Database, env: StravaEnv, link: StravaLink | undefined, rodeAt: number, lengthMin: number,
                                  fetcher: typeof fetch = fetch) {
  if (!link) throw new UserError('Connect Strava first in Settings ⚙.');
  if (!rodeAt) throw new UserError('No ride time for this class.');
  type Activity = { id: number; name: string; start_date: string; average_watts?: number; average_cadence?: number;
    has_heartrate?: boolean; average_heartrate?: number };
  const acts = await stravaGet<Activity[]>(db, env, link, `/athlete/activities?after=${rodeAt - 1800}&before=${rodeAt + 1800}&per_page=10`, fetcher);
  const best = acts.map((a) => ({ a, gap: Math.abs(Date.parse(a.start_date) / 1000 - rodeAt) }))
    .filter((x) => x.gap <= 1800).sort((x, y) => x.gap - y.gap)[0];
  if (!best) throw new UserError('No Strava activity found at the time of this ride. Is your Peloton connected to Strava?');
  const a = best.a;
  // One request returns every trace we draw (Strava's limits count requests, not traces).
  type Stream = { data: (number | null)[] };
  const streams = await stravaGet<{ time?: Stream; watts?: Stream; heartrate?: Stream; cadence?: Stream }>(db, env, link,
    `/activities/${a.id}/streams?keys=time,watts,heartrate,cadence&key_by_type=true`, fetcher);
  if (!streams.watts?.data?.length || !streams.time?.data?.length) throw new UserError('That Strava activity has no power data.');
  const time = streams.time.data as number[];
  const secs = Math.min(4 * 3600, Math.max(time[time.length - 1] + 1, (lengthMin || 0) * 60));   // bounded: 4 h max
  // One value per second of the ride, gaps filled with the last reading. A missing trace comes back empty.
  const perSecond = (st?: Stream) => {
    const d = st?.data; if (!d?.length) return [] as number[];
    const out: (number | null)[] = new Array(secs).fill(null);
    for (let i = 0; i < time.length && i < d.length; i++) if (time[i] < secs && d[i] != null) out[time[i]] = Math.round(d[i] as number);
    for (let i = 1; i < secs; i++) if (out[i] === null) out[i] = out[i - 1];
    return out.map((v) => v ?? 0);
  };
  const watts = perSecond(streams.watts), heartrate = perSecond(streams.heartrate), cadences = perSecond(streams.cadence);
  return {
    id: a.id, name: a.name, start: a.start_date, avgWatts: Math.round(a.average_watts || 0),
    cadence: Math.round(a.average_cadence || 0), hr: a.has_heartrate ? Math.round(a.average_heartrate || 0) : 0,
    ftp: link.ftp || 0, watts, heartrate: heartrate.some((v) => v > 0) ? heartrate : [],
    cadences: cadences.some((v) => v > 0) ? cadences : [],
  };
}
