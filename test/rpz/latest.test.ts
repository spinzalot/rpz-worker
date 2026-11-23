import { it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { apiProgress, type RpzEnv } from '../../src/rpz/api';
import { seed, ME } from './fixture';

const e = env as unknown as RpzEnv;

beforeAll(async () => {
  await seed(e.RPZ_DB);
  // A second ride of p1's class, later in P29's window.
  await e.RPZ_DB.prepare(`insert into completions (rider_id,ridden_at,class_key,source) values (?,1794600000,'1750000000|45|45 min power zone endurance ride','sync')`)
    .bind(ME).run();
});

it('reports the latest ride of a class ridden more than once', async () => {
  const p = await apiProgress(e.RPZ_DB, ME, 'P29', false, true);
  expect(p.classes.find((x) => x.id === 'p1')).toMatchObject({ done: true, rodeAt: 1794600000 });
});

it('still gives twins one ride each, oldest first', async () => {
  const p = await apiProgress(e.RPZ_DB, ME, 'CW-PZ', false, true);
  expect(p.classes.find((x) => x.id === 'a1')).toMatchObject({ done: true, rodeAt: 1754000000 });
  expect(p.classes.find((x) => x.id === 'a2')).toMatchObject({ done: false });
});
