import { it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { apiGroupRide, apiGroupRsvp, nextGroupRide, type RpzEnv } from '../../src/rpz/api';
import { seed, ME, BUDDY } from './fixture';

const e = env as unknown as RpzEnv;
// Fixture: P29 has 6 weeks ending 2026-12-27, so Week 1 starts Mon 2026-11-09 and Week 6's Saturday is 2026-12-19.
const FRI_NOON = Date.UTC(2026, 11, 18, 18, 0) / 1000;        // Fri Dec 18, 12:00 PM Central (CST, UTC-6)
const SAT_START = Date.UTC(2026, 11, 19, 15, 59) / 1000;      // Sat Dec 19, 9:59 AM Central

beforeAll(async () => {
  await seed(e.RPZ_DB);
});

it('finds this Saturday, 9:59 AM Central, and rolls to next week 3 hours after the start', () => {
  expect(nextGroupRide('sat', FRI_NOON)).toMatchObject({ id: 'sat-2026-12-19', date: '2026-12-19', startsAt: SAT_START });
  expect(nextGroupRide('sat', SAT_START + 2 * 3600).id).toBe('sat-2026-12-19');   // still on the ride
  expect(nextGroupRide('sat', SAT_START + 3 * 3600).id).toBe('sat-2026-12-26');
  // Daylight saving: a summer Saturday starts at 9:59 CDT (UTC-5).
  expect(nextGroupRide('sat', Date.UTC(2026, 6, 1, 12) / 1000).startsAt).toBe(Date.UTC(2026, 6, 4, 14, 59) / 1000);
});

it("picks the current program's Saturday class and says whether I've ridden it", async () => {
  const r = await apiGroupRide(e.RPZ_DB, ME, 'sat', FRI_NOON);
  expect(r.program).toMatchObject({ id: 'P29', week: 6 });
  expect(r.class).toMatchObject({ id: 'p2', title: '60 min Power Zone Ride', instructor: 'Denis Morton', len: 60, done: true });
  expect(r.rsvps).toEqual([]);
});

it('records in / maybe / out for the current ride only', async () => {
  let r = await apiGroupRsvp(e.RPZ_DB, ME, 'sat', 'sat-2026-12-19', 'in', FRI_NOON);
  expect(r.mine).toBe('in');
  r = await apiGroupRsvp(e.RPZ_DB, BUDDY, 'sat', 'sat-2026-12-19', 'maybe', FRI_NOON);
  expect(r.rsvps).toEqual([{ name: 'spinzalot', status: 'in' }, { name: 'TheFinder', status: 'maybe' }]);
  r = await apiGroupRsvp(e.RPZ_DB, BUDDY, 'sat', 'sat-2026-12-19', 'out', FRI_NOON);
  expect(r).toMatchObject({ out: 1, rsvps: [{ name: 'spinzalot', status: 'in' }] });
  r = await apiGroupRsvp(e.RPZ_DB, ME, 'sat', 'sat-2026-12-19', '', FRI_NOON);   // take it back
  expect(r.mine).toBe('');
  await expect(apiGroupRsvp(e.RPZ_DB, ME, 'sat', 'sat-2026-12-12', 'in', FRI_NOON)).rejects.toThrow('That ride is over');
  await expect(apiGroupRsvp(e.RPZ_DB, ME, 'sat', 'sat-2026-12-19', 'yes', FRI_NOON)).rejects.toThrow('Pick In');
});

it('has no class when no program covers that Saturday', async () => {
  const r = await apiGroupRide(e.RPZ_DB, ME, 'sat', SAT_START + 3 * 3600);   // rolls to Dec 26: no Week 7
  expect(r).toMatchObject({ ride: { id: 'sat-2026-12-26' }, program: null, class: null });
});
