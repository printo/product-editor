import type { HolidayEntry } from '@/types/calendar';

/** Same labels CalendarLayoutEditor's locale select uses. */
export const HOLIDAY_LOCALES: { value: string; label: string }[] = [
  { value: 'en-IN', label: 'en-IN (India)' },
  { value: 'generic', label: 'generic (universal)' },
];

export const HOLIDAY_TYPES = ['national', 'festival', 'religious', 'observance'] as const;

export const MAX_HOLIDAY_NAME = 60;

/** Matches the server's `_safe_locale_year` locale rule. */
export function isSafeLocale(locale: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(locale);
}

/** A row being edited locally. `id` exists only in the browser, so two
 *  holidays on the same date can be told apart. */
export interface HolidayRow extends HolidayEntry {
  id: string;
}

export interface HolidayFields {
  date: string;
  name: string;
  type: string;
  color: string;
}

export type HolidayErrors = Partial<Record<keyof HolidayFields, string>>;

export const EMPTY_FIELDS: HolidayFields = { date: '', name: '', type: '', color: '' };

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Checks one holiday before it joins the list. Mirrors what `HolidaysView.put`
 * refuses (a real date in the URL year, a non-empty name) so ops hear about it
 * on the field rather than as a 400 for the whole year on Save. `others` is
 * the rest of the list, for the duplicate check.
 */
export function validateHoliday(
  fields: HolidayFields,
  year: number,
  others: HolidayEntry[],
): HolidayErrors {
  const errors: HolidayErrors = {};
  const date = fields.date.trim();
  const name = fields.name.trim();
  const color = fields.color.trim();

  if (!date) {
    errors.date = 'Pick a date.';
  } else if (!isRealIsoDate(date)) {
    errors.date = 'Enter a real date as YYYY-MM-DD.';
  } else if (Number(date.slice(0, 4)) !== year) {
    errors.date = `Pick a date in ${year} — this list only holds ${year}'s holidays. Switch the year above for another year.`;
  }

  if (!name) {
    errors.name = 'Enter a name, e.g. "Republic Day".';
  } else if (name.length > MAX_HOLIDAY_NAME) {
    errors.name = `Keep the name to ${MAX_HOLIDAY_NAME} characters or fewer (it has ${name.length}) — it has to fit in a calendar cell.`;
  }

  if (color && !HEX_COLOR.test(color)) {
    errors.color = 'Use a hex colour like #DC2626, or leave it blank for the default.';
  }

  if (!errors.date && !errors.name) {
    const clash = others.some(
      (h) => h.date === date && h.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (clash) errors.name = `"${name}" is already listed on this date.`;
  }

  return errors;
}

/** The entry as the server stores it: optional fields left out when blank. */
export function fieldsToEntry(fields: HolidayFields): HolidayEntry {
  const entry: HolidayEntry = { date: fields.date.trim(), name: fields.name.trim() };
  if (fields.type) entry.type = fields.type;
  const color = fields.color.trim();
  if (color) entry.color = color.toUpperCase();
  return entry;
}

export function entryToFields(entry: HolidayEntry): HolidayFields {
  return { date: entry.date, name: entry.name, type: entry.type ?? '', color: entry.color ?? '' };
}

export function sortHolidays<T extends HolidayEntry>(list: T[]): T[] {
  return [...list].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** Strips the browser-only ids, so a list can be compared or sent. */
export function toEntries(rows: HolidayRow[]): HolidayEntry[] {
  return sortHolidays(rows).map(({ id: _id, ...entry }) => entry);
}

/** "26 Jan, Mon" — read in UTC so the browser's timezone can't shift the day. */
export function formatHolidayDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
    timeZone: 'UTC',
  });
}
