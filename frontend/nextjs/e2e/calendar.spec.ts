/**
 * The months of a calendar in the customer editor. A layout that prints one
 * month to a page draws each month on a card, with its date grid where the
 * print puts it. One that prints several months to a page (the whole-year
 * poster) cannot, and keeps the twelve month tiles under the cards. The suite
 * runs on whichever calendar layout the local catalogue holds, so the test for
 * the other kind skips.
 */
import { expect, test, type Page } from '@playwright/test';
import { createEmbedSession } from './support/api';
import { PHOTOS, addPhotos, cards, openEmbedEditor } from './support/editor';

/** The parts of the served layout that decide how the editor shows a calendar. */
type ServedCalendar = {
  calendars?: unknown[];
  calendar?: { holidaySource?: { enabled?: unknown; locale?: unknown } | null } | null;
};

const MONTHS_CHECKED = ['January', 'June', 'December'];

/** A month's date grid on its card: the tap target for the day editor. */
const monthGrids = (page: Page) => page.getByRole('button', { name: /^Add dates to [A-Z][a-z]+ \d{4}$/ });

/** A month tile under the cards. */
const monthTiles = (page: Page) => page.getByRole('img', { name: /^[A-Z][a-z]+ \d{4} preview$/ });

/** Opens the calendar layout in the embed. Returns the layout as the editor
 *  was served it, and the holiday files the page asks for (filled as it asks). */
async function openCalendar(page: Page) {
  const holidayRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/holidays/')) holidayRequests.push(new URL(r.url()).pathname);
  });
  const { token } = await createEmbedSession();
  const [init] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/editor/init') && r.ok()),
    openEmbedEditor(page, token, process.env.E2E_CALENDAR_LAYOUT as string),
  ]);
  const { layout } = (await init.json()) as { layout: ServedCalendar };
  return { layout, holidayRequests };
}

/** Holidays are loaded only where the print carries them, from the locale it prints. */
async function expectHolidaysAsPrinted(layout: ServedCalendar, requested: string[]) {
  const source = layout.calendar?.holidaySource;
  if (!source?.enabled) {
    expect(requested).toEqual([]);
    return;
  }
  const locale = typeof source.locale === 'string' && source.locale ? source.locale : 'generic';
  await expect.poll(() => requested.length).toBeGreaterThan(0);
  for (const path of requested) {
    expect(path).toContain(`/holidays/${encodeURIComponent(locale)}/`);
    expect(path).toMatch(/\/\d{4}$/);
  }
}

test.describe('calendar layout', () => {
  test.beforeEach(() => {
    test.skip(!process.env.E2E_CALENDAR_LAYOUT, 'No calendar layout in the local catalogue.');
  });

  test('a one-month-a-page calendar shows each month as a card with its dates', async ({ page }) => {
    const { layout, holidayRequests } = await openCalendar(page);
    test.skip(layout.calendars?.length !== 1, 'The local calendar layout prints several months to a page: see the month tiles test.');

    await expect(page.getByRole('group', { name: 'Calendar type' })).toBeVisible();
    await addPhotos(page, [PHOTOS.portrait]);

    for (const month of MONTHS_CHECKED) {
      await expect(page.getByRole('button', { name: new RegExp(`^Add dates to ${month} \\d{4}$`) })).toBeVisible();
    }
    await expect(monthGrids(page)).toHaveCount(12);
    // One photo makes one card. The other eleven months print with it again,
    // and each offers a photo of its own.
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Add a photo for [A-Z][a-z]+$/ })).toHaveCount(11);
    await expect(monthTiles(page)).toHaveCount(0);

    // A tap on a card's dates opens the day editor on that month and nothing
    // else: it is the one window open, and closing it leaves none. The photo
    // editor, which the rest of the card opens, stays shut.
    const dates = cards(page).first().getByRole('button', { name: /^Add dates to / });
    const month = ((await dates.getAttribute('aria-label')) ?? '').replace('Add dates to ', '').split(' ')[0];
    await dates.click();
    const dayEditor = page.getByRole('dialog', { name: new RegExp(month) });
    await expect(dayEditor).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await dayEditor.getByRole('button', { name: 'Close cell editor' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expectHolidaysAsPrinted(layout, holidayRequests);
  });

  test('a calendar with several months to a page keeps the twelve month tiles', async ({ page }) => {
    const { layout, holidayRequests } = await openCalendar(page);
    test.skip(layout.calendars?.length === 1, 'The local calendar layout prints one month to a page: see the month cards test.');

    await expect(page.getByRole('group', { name: 'Calendar type' })).toBeVisible();
    await addPhotos(page, [PHOTOS.portrait]);

    for (const month of MONTHS_CHECKED) {
      await expect(page.getByRole('img', { name: new RegExp(`^${month} \\d{4} preview$`) })).toBeVisible();
    }
    await expect(monthTiles(page)).toHaveCount(12);
    // The photo's card is there, and carries no date grid of its own.
    await expect(cards(page)).toHaveCount(1);
    await expect(monthGrids(page)).toHaveCount(0);

    await expectHolidaysAsPrinted(layout, holidayRequests);
  });
});
