import { expect, test } from '@playwright/test';
import { createEmbedSession } from './support/api';
import { PHOTOS, addPhotos, cards, openEmbedEditor, photoOrder, recordAutosaves } from './support/editor';

test.describe('on a phone (touch, small screen)', () => {
  test('add photos, tap-to-swap them, and open the editor sheet', async ({ page }) => {
    const { token } = await createEmbedSession();
    const saves = recordAutosaves(page);
    await openEmbedEditor(page, token);
    await addPhotos(page, [PHOTOS.portrait, PHOTOS.landscape]);
    await expect(cards(page)).toHaveCount(2);
    await expect.poll(() => photoOrder(saves.at(-1)), { timeout: 30_000 })
      .toEqual(['portrait-3000x4000.jpg', 'landscape-4000x3000.jpg']);

    await page.getByTitle('Swap Photo').first().tap();
    await expect(page.getByText('Tap another photo to swap')).toBeVisible();
    await cards(page).nth(1).tap();
    await expect.poll(() => photoOrder(saves.at(-1)), { timeout: 30_000 })
      .toEqual(['landscape-4000x3000.jpg', 'portrait-3000x4000.jpg']);

    await cards(page).first().tap();
    const editor = page.getByRole('dialog', { name: 'Canvas editor' });
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: 'Close editor' }).tap();
    await expect(editor).toBeHidden();
  });
});
