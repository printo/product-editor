import { expect, test } from '@playwright/test';
import { createEmbedSession } from './support/api';
import { PHOTOS, addPhotos, openEmbedEditor } from './support/editor';

test.describe('calendar layout', () => {
  test('the preview shows the months and loads the holidays the print carries', async ({ page }) => {
    const layout = process.env.E2E_CALENDAR_LAYOUT;
    test.skip(!layout, 'No calendar layout in the local catalogue.');
    const holidayRequests: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/holidays/')) holidayRequests.push(new URL(r.url()).pathname); });
    const { token } = await createEmbedSession();
    await openEmbedEditor(page, token, layout);
    await expect(page.getByRole('group', { name: 'Calendar type' })).toBeVisible();
    await addPhotos(page, [PHOTOS.portrait]);
    // Twelve month tiles, each an image labelled "<Month> <year> preview".
    for (const month of ['January', 'June', 'December']) {
      await expect(page.getByRole('img', { name: new RegExp(`^${month} \\d{4} preview$`) })).toBeVisible();
    }
    await expect(page.getByRole('img', { name: /^[A-Z][a-z]+ \d{4} preview$/ })).toHaveCount(12);
    await expect.poll(() => holidayRequests.length).toBeGreaterThan(0);
    expect(holidayRequests[0]).toMatch(/\/holidays\/[A-Za-z-]+\/\d{4}$/);
  });
});
