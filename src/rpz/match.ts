// Matching rides from a Peloton workouts CSV to challenge classes. A line-for-line port of the
// Apps Script prototype (RPZ_Phase1.gs / RPZ_Phase2_Sync.gs), so both give the same answers.
import { tzOffset } from './dates';

// ---------- titles and keys ----------

export function normalizeTitle(title: unknown): string {
  return String(title ?? '')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
/** Forgiving title (and instructor name) for the fallback match: no accents, letters and digits only. */
export function looseTitle(t: unknown): string {
  return String(t ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
export const snapEpoch = (sec: number) => Math.round(sec / 1800) * 1800;
export const makeClassKey = (epochSec: number, lengthMin: number, title: string) =>
  snapEpoch(epochSec) + '|' + Number(lengthMin) + '|' + normalizeTitle(title);

/** Title -> type from the type rules (first match by ord wins), or Other. */
export function typeClassifier(rules: { ord: number; title_contains: string; type: string }[]) {
  const sorted = rules.filter((r) => r.title_contains).sort((a, b) => a.ord - b.ord)
    .map((r) => ({ needle: normalizeTitle(r.title_contains), type: r.type }));
  return (title: string) => sorted.find((r) => normalizeTitle(title).includes(r.needle))?.type ?? 'Other';
}

// ---------- timestamps ----------

const ZONE_MAP: Record<string, string> = {
  EDT: 'America/New_York', EST: 'America/New_York', CDT: 'America/Chicago', CST: 'America/Chicago',
  MDT: 'America/Denver', MST: 'America/Denver', PDT: 'America/Los_Angeles', PST: 'America/Los_Angeles',
  HST: 'Pacific/Honolulu', BST: 'Europe/London', GMT: 'Etc/UTC', UTC: 'Etc/UTC', CET: 'Europe/Paris', CEST: 'Europe/Paris',
};

/** "2025-10-22 16:30 (-05)" or "(CDT)" -> UTC epoch seconds; null if unreadable. Unknown zones read as Eastern. */
export function tsToEpoch(ts: unknown): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*(?:\(([^)]+)\))?/.exec(String(ts ?? '').trim());
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
  const tz = (m[6] || '').trim().toUpperCase();
  const num = /^([+-])?(\d{1,2}):?(\d{2})?$/.exec(tz);
  if (num) return wall - (num[1] === '-' ? -1 : 1) * (Number(num[2]) * 60 + Number(num[3] || 0)) * 60;
  const zone = ZONE_MAP[tz] || 'America/New_York';
  const first = wall - tzOffset(wall, zone);
  return wall - tzOffset(first, zone);   // re-check across a DST switch
}

// ---------- CSV ----------

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ''));
}

// ---------- matching ----------

export interface MatchClass { class_key: string; title: string; instructor: string; length_min: number; air_epoch: number }
export interface MatchedRide { key: string; riddenAt: number }
export interface MatchResult {
  cycling: number; matched: number; viaUtc: number; guessed: number;
  rides: MatchedRide[];   // every matched ride in the file (stored or not)
  misses: string[];
}

const MATCH_WINDOW = 12 * 3600;

/**
 * Exact key first (no instructor check: works for multi-instructor rides). Otherwise the same
 * length and loose title, nearest air time within 12 hours, and the class's instructor must be the
 * ride's (accent-free). A class with no known instructor (blank or "Multiple") is used only when
 * it's the sole candidate.
 */
export function matchRides(csvText: string, classes: MatchClass[], classify: (t: string) => string, username = 'rider'): MatchResult {
  const rows = parseCsv(csvText.replace(/^﻿/, ''));
  const header = (rows.shift() || []).map((s) => s.trim().toLowerCase());
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(username + ': CSV has no "' + name + '" column. Columns: ' + header.join(', '));
    return i;
  };
  const cW = col('workout timestamp'), cI = col('instructor name'), cL = col('length (minutes)'),
        cD = col('fitness discipline'), cT = col('title'), cC = col('class timestamp');

  const keySet = new Set(classes.map((c) => c.class_key));
  const byLenTitle = new Map<string, { epoch: number; key: string; instructor: string }[]>();
  for (const c of classes) {
    const k = c.length_min + '|' + looseTitle(c.title);
    if (!byLenTitle.has(k)) byLenTitle.set(k, []);
    byLenTitle.get(k)!.push({ epoch: c.air_epoch, key: c.class_key, instructor: looseTitle(c.instructor) });
  }

  const out: MatchResult = { cycling: 0, matched: 0, viaUtc: 0, guessed: 0, rides: [], misses: [] };
  for (const r of rows) {
    if ((r[cD] || '').trim().toLowerCase() !== 'cycling') continue;
    out.cycling++;
    const title = (r[cT] || '').trim();
    const len = Number(r[cL]);
    const classEpoch = tsToEpoch(r[cC]);
    if (classEpoch === null || !title) continue;

    let best: { d: number; key: string; unknown?: boolean } | null = null;
    const exact = makeClassKey(classEpoch, len, title);
    if (keySet.has(exact)) best = { d: 0, key: exact };
    else {
      const rideInstructor = looseTitle(r[cI]);
      const unknown = (c: { instructor: string }) => !c.instructor || c.instructor === 'multiple';
      const inWindow = (byLenTitle.get(len + '|' + looseTitle(title)) || [])
        .filter((c) => Math.abs(c.epoch - classEpoch) <= MATCH_WINDOW)
        .filter((c) => unknown(c) || c.instructor === rideInstructor);
      for (const c of inWindow) {
        const d = Math.abs(c.epoch - classEpoch);
        if (!best || d < best.d) best = { d, key: c.key, unknown: unknown(c) };
      }
      if (best?.unknown && new Set(inWindow.map((c) => c.key)).size > 1) best = null;   // ambiguous: don't guess
      if (best?.unknown) out.guessed++;
    }
    if (!best) {
      const same = byLenTitle.get(len + '|' + looseTitle(title)) || [];
      if (same.length && classify(title) !== 'Other') {
        const near = Math.min(...same.map((c) => Math.abs(c.epoch - classEpoch)));
        out.misses.push(`${r[cC]}  ${title}  (${r[cI]}; nearest same-title class ${(near / 3600).toFixed(1)} h away)`);
      }
      continue;
    }
    if (best.d >= 1800) out.viaUtc++;
    out.matched++;
    const riddenAt = tsToEpoch(r[cW]);
    if (riddenAt !== null) out.rides.push({ key: best.key, riddenAt });
  }
  return out;
}
