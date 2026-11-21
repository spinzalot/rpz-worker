import { describe, it, expect } from 'vitest';
import { matchRides, tsToEpoch, parseCsv, makeClassKey, typeClassifier } from '../../src/rpz/match';

const HEADER = 'Workout Timestamp,Live/On-Demand,Instructor Name,Length (minutes),Fitness Discipline,Type,Title,Class Timestamp,Total Output';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const classify = typeClassifier([{ ord: 1, title_contains: 'Power Zone Endurance', type: 'PZE' }, { ord: 5, title_contains: 'Power Zone', type: 'PZ' }]);
const cls = (epoch: number, len: number, title: string, instructor: string) =>
  ({ class_key: makeClassKey(epoch, len, title), title, instructor, length_min: len, air_epoch: epoch });

describe('timestamps', () => {
  it('reads numeric offsets and zone names, DST-aware', () => {
    expect(tsToEpoch('2025-10-22 16:30 (-05)')).toBe(1761168600);
    expect(tsToEpoch('2024-02-16 08:00 (CST)')).toBe(1708092000);
    expect(tsToEpoch('2024-07-16 08:00 (CDT)')).toBe(1721134800);
    expect(tsToEpoch('nonsense')).toBeNull();
  });
});

describe('csv', () => {
  it('handles quoted fields with commas, quotes and a BOM-less header', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });
});

describe('matching', () => {
  const erik = cls(1725631200, 60, '60 min Power Zone Endurance Ride', 'Erik Jäger');
  it('matches an exact key without checking the instructor', () => {
    const r = matchRides(csv('2026-07-28 04:53 (-05),On Demand,Someone Else,60,Cycling,,60 min Power Zone Endurance Ride,2024-09-06 09:00 (-05),400'), [erik], classify);
    expect(r).toMatchObject({ cycling: 1, matched: 1, viaUtc: 0 });
    expect(r.rides[0].key).toBe(erik.class_key);
  });
  it('falls back to the nearest air time when the export time is off, if the instructor matches without accents', () => {
    const r = matchRides(csv('2026-07-28 04:53 (-05),On Demand,Erik Jager,60,Cycling,,60 min Power Zone Endurance Ride,2024-09-06 10:00 (-05),400'), [erik], classify);
    expect(r).toMatchObject({ matched: 1, viaUtc: 1 });
  });
  it('refuses the fallback for a different instructor and reports a possible miss', () => {
    const r = matchRides(csv('2026-07-28 04:53 (-05),On Demand,Charlotte Weidenbach,60,Cycling,,60 min Power Zone Endurance Ride,2024-09-06 10:00 (-05),400'), [erik], classify);
    expect(r.matched).toBe(0);
    expect(r.misses).toHaveLength(1);
  });
  it('uses a class with no known instructor only when it is the sole candidate', () => {
    const a = cls(1725631200, 60, '60 min Power Zone Ride', 'Multiple');
    const b = cls(1725634800, 60, '60 min Power Zone Ride', '');
    const row = '2026-07-28 04:53 (-05),On Demand,Matt Wilpers,60,Cycling,,60 min Power Zone Ride,2024-09-06 11:30 (-05),400';
    expect(matchRides(csv(row), [a], classify)).toMatchObject({ matched: 1, guessed: 1 });
    expect(matchRides(csv(row), [a, b], classify).matched).toBe(0);
  });
  it('ignores non-cycling rows and explains a missing column', () => {
    expect(matchRides(csv('2026-07-28 04:53 (-05),On Demand,X,20,Strength,,20 min Upper Body,2024-09-06 09:00 (-05),'), [erik], classify).cycling).toBe(0);
    expect(() => matchRides('Title,Length (minutes)\nx,1', [erik], classify, 'jim')).toThrow(/no "workout timestamp" column/);
  });
});
