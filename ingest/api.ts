/*
Generates the static data API served from /api/v1/.

Everything is emitted at build time into `public/api/v1/` (which Vite copies verbatim
into `dist/`), so the endpoints are plain files on the CDN rather than Worker routes.

Endpoints:
  /api/v1/signature.json      - just the hashes + lunch window (cheap to poll)
  /api/v1/schedules.json      - schedules and their period times, with `dates` resolved
  /api/v1/schedule-dates.json - the raw schedule name -> dates map
  /api/v1/lunch.json          - one menu per school day in a rolling window

Each signature is a hash of the section's JSON *data* in canonical form, so it only moves
when the data actually changes - never for formatting or key order. The lunch signature
covers the source menus rather than the response: the lunch window shifts every day (the
site is rebuilt nightly) without changing the hash, and clients use `window.refreshAfter`
for that instead.
*/

import canonicalize from 'canonicalize';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import scheduleDates from '../src/data/schedule-dates.json';
import Bell from '../src/utils/bell';
import { rotatingMenuMap } from '../src/utils/food/rotating-map';
import schedules from '../src/utils/official-schedules';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'public/api/v1');

const VERSION = 1;
const DAYS_BEHIND = 7;
const DAYS_AHEAD = 21;
// once fewer than this many days of future menus remain, clients should refetch
const REFRESH_MARGIN_DAYS = 7;

/**
 * SHA-256 over a value's canonical JSON (RFC 8785): keys sorted, whitespace and number
 * formatting normalized. The hash depends only on the data, not on how a file is laid out.
 */
const hashJSON = (value: unknown): string => createHash('sha256').update(canonicalize(value)!).digest('hex');

/** Local-time YYYY-MM-DD. The rest of the app works in local time, so this does too. */
function toISODate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

// ---------------------------------------------------------------------------
// lunch
// ---------------------------------------------------------------------------

// `--today <date>` pins the window's anchor date, which makes the output reproducible
// and lets you inspect a window other than the one around the real current date.
function anchorDate(): Date {
  const args = process.argv.slice(2);
  const index = args.indexOf('--today');
  if (index === -1) return startOfDay(new Date());

  const raw = args[index + 1] ?? '';
  // Built from local components on purpose: `new Date('2026-09-20')` is parsed as UTC
  // midnight, which startOfDay then pulls back to the 19th anywhere west of Greenwich.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new Error(`--today: expected YYYY-MM-DD, got "${raw}"`);
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(year, month - 1, day);
  // `new Date(2026, 1, 31)` rolls over to March 3 rather than failing, so reject
  // anything that didn't survive the round trip.
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    throw new Error(`--today: "${raw}" is not a real calendar date`);
  }
  return startOfDay(parsed);
}

const today = anchorDate();
const validFrom = startOfDay(rotatingMenuMap.validFrom);
const validTo = startOfDay(rotatingMenuMap.validTo);

const requestedStart = addDays(today, -DAYS_BEHIND);
const requestedEnd = addDays(today, DAYS_AHEAD);
const windowStart = requestedStart < validFrom ? validFrom : requestedStart;
const windowEnd = requestedEnd > validTo ? validTo : requestedEnd;

type LunchDay = {
  date: string;
  menu: ReturnType<typeof rotatingMenuMap.getMenuUnchecked>;
};

const days: LunchDay[] = [];
for (let date = windowStart; date <= windowEnd; date = addDays(date, 1)) {
  const scheduleType = Bell.getScheduleType(date, schedules);
  // no menu on weekends, holidays, or over the summer - same gate LunchCard.vue uses
  // (a schedule with no modes means there's no school that day)
  if (scheduleType.modes.length === 0 || scheduleType.name === 'Summer') continue;

  days.push({
    date: toISODate(date),
    menu: rotatingMenuMap.getMenuUnchecked(date),
  });
}

if (days.length === 0) {
  console.warn(
    `[api] No lunch menus generated: no school day in the requested window (${toISODate(requestedStart)} to ${toISODate(requestedEnd)}) `
    + `falls inside the rotating menu's valid range (${toISODate(validFrom)} to ${toISODate(validTo)}). `
    + 'If school is in session, the menu data in src/data/lunch-rotating/ is likely out of date.',
  );
}

// Clamping against the valid range can leave nothing at all (the menu data has expired,
// or the school year hasn't started yet), in which case there's no window to report.
const isEmpty = windowEnd < windowStart;

// If the valid range cut the window short there are no more menus to wait for, but we
// still never point refreshAfter before the start of the window.
const refreshCandidate = addDays(windowEnd, -REFRESH_MARGIN_DAYS);
const refreshAfter = refreshCandidate < windowStart ? windowStart : refreshCandidate;

const lunchWindow = {
  start: isEmpty ? null : toISODate(windowStart),
  end: isEmpty ? null : toISODate(windowEnd),
  // refetch once the current date reaches this, i.e. when only a week of menus is left.
  // With nothing to expire, there's no point holding a client off past the anchor date.
  refreshAfter: toISODate(isEmpty ? today : refreshAfter),
};

const lunch = {
  window: lunchWindow,
  validRange: { start: toISODate(validFrom), end: toISODate(validTo) },
  days,
};

// ---------------------------------------------------------------------------
// signature
// ---------------------------------------------------------------------------

// schedules and scheduleDates are hashed exactly as served, so the schedules hash also
// moves when a resolved `dates` entry changes in schedule-dates.json.
// The lunch hash covers everything that decides the menus except the window itself: the
// menu data as the rotating map loaded it, the rotation config, and the schedule fields
// the gate above reads to pick school days (period times are left out, since they don't
// affect lunch).
const signature = {
  schedules: hashJSON(schedules),
  scheduleDates: hashJSON(scheduleDates),
  lunch: hashJSON({
    menus: { stations: rotatingMenuMap.stations, special: rotatingMenuMap.special },
    rotationConfig: {
      validFrom: toISODate(validFrom),
      validTo: toISODate(validTo),
      semesterSwitch: toISODate(rotatingMenuMap.semesterSwitch),
      offset: rotatingMenuMap.offset,
      cyclePeriod: rotatingMenuMap.cycle_period,
    },
    schoolDays: schedules.map(({ name, dates, modes }) => ({ name, dates, hasSchool: modes.length > 0 })),
  }),
};

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const generatedAt = new Date().toISOString();
// signature.json carries every section's hash so clients can poll it; each data endpoint
// carries only its own
const envelope = (sectionSignature: unknown) => ({ version: VERSION, generatedAt, signature: sectionSignature });

const endpoints: Record<string, unknown> = {
  'signature.json': { ...envelope(signature), lunchWindow },
  'schedules.json': { ...envelope(signature.schedules), schedules },
  'schedule-dates.json': { ...envelope(signature.scheduleDates), scheduleDates },
  'lunch.json': { ...envelope(signature.lunch), ...lunch },
};

mkdirSync(outDir, { recursive: true });
for (const [name, body] of Object.entries(endpoints)) {
  writeFileSync(resolve(outDir, name), `${JSON.stringify(body, null, 2)}\n`);
}

console.log(
  `Saved ${Object.keys(endpoints).length} endpoints to ${relative(root, outDir)} `
  + `(${schedules.length} schedules, ${days.length} lunch days)`,
);
