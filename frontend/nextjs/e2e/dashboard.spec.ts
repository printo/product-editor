import fs from 'node:fs';
import JSZip from 'jszip';
import { expect, test } from '@playwright/test';
import { newOrderId, rememberOrder } from './support/api';
import { signIn } from './support/auth';
import { PHOTOS, addPhotos, cards, layoutName } from './support/editor';

test.describe('dashboard (staff, signed in without a password)', () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context, 'editor');
  });

  test('the dashboard lists templates and opens one in the editor', async ({ page }) => {
    await page.goto('/dashboard');
    const link = page.locator(`a[href="/editor/layout/${layoutName()}"]`).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/editor/layout/${layoutName()}`));
    await expect(page.locator('input[type="file"][multiple]')).toBeAttached();
    const orderId = new URL(page.url()).searchParams.get('order_id');
    if (orderId) rememberOrder(orderId);
  });

  test('Download renders on the server and saves a ZIP with the print files', async ({ page }) => {
    test.skip(process.env.E2E_WORKERS === '0', 'No Celery worker is running, so a render cannot complete (see e2e/README.md).');
    const orderId = newOrderId();
    rememberOrder(orderId);
    await page.goto(`/editor/layout/${layoutName()}?order_id=${orderId}`);
    await addPhotos(page, [PHOTOS.portrait]);
    await expect(cards(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Download' }).click();
    const options = page.getByRole('dialog', { name: 'Ready to Download?' });
    await expect(options).toBeVisible();
    await options.getByRole('checkbox').first().check();
    const download = page.waitForEvent('download', { timeout: 180_000 });
    await options.getByRole('button', { name: /ZIP Archive/ }).click();
    const file = await download;
    // The server's Content-Disposition name (layout + short job id) wins over the link's.
    const name = file.suggestedFilename();
    expect(name.startsWith(layoutName())).toBe(true);
    expect(name.slice(layoutName().length)).toMatch(/^(-[0-9a-f]{8})?\.zip$/);
    const zip = await JSZip.loadAsync(fs.readFileSync(await file.path()));
    const names = Object.keys(zip.files);
    expect(names.some((n) => /\.png$/i.test(n))).toBe(true);
  });

  test('Imposition builds print sheets and downloads them', async ({ page }) => {
    const orderId = newOrderId();
    rememberOrder(orderId);
    await page.goto(`/editor/layout/${layoutName()}?order_id=${orderId}`);
    await addPhotos(page, [PHOTOS.portrait, PHOTOS.square]);
    await expect(cards(page)).toHaveCount(2);
    await page.getByRole('button', { name: 'Download' }).click();
    const options = page.getByRole('dialog', { name: 'Ready to Download?' });
    await options.getByRole('checkbox').first().check();
    await options.getByRole('button', { name: /Imposition/ }).click();
    await expect(page.getByText('Sheet preview')).toBeVisible();
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await page.getByRole('button', { name: /^Download (\d+ )?print sheets?$/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBeTruthy();
    expect(fs.statSync(await file.path()).size).toBeGreaterThan(0);
  });

  test('the download options and the print-sheet window cover the top bar', async ({ page }) => {
    const orderId = newOrderId();
    rememberOrder(orderId);
    await page.goto(`/editor/layout/${layoutName()}?order_id=${orderId}`);
    await addPhotos(page, [PHOTOS.portrait]);
    await expect(cards(page)).toHaveCount(1);
    const back = page.getByRole('button', { name: 'Back to templates' });
    const box = (await back.boundingBox())!;
    // What a click on Back to Templates would actually land on.
    const hitsBack = () => page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return !!el?.closest('header');
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(await hitsBack()).toBe(true);
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const options = page.getByRole('dialog', { name: 'Ready to Download?' });
    await expect(options).toBeVisible();
    expect(await hitsBack()).toBe(false);
    await options.getByRole('checkbox').first().check();
    await options.getByRole('button', { name: /Imposition/ }).click();
    await expect(page.getByRole('dialog', { name: 'Print settings' })).toBeVisible();
    expect(await hitsBack()).toBe(false);
  });

  test('the print-sheet window takes focus, keeps Tab inside, and Escape gives focus back to Download', async ({ page }) => {
    const orderId = newOrderId();
    rememberOrder(orderId);
    await page.goto(`/editor/layout/${layoutName()}?order_id=${orderId}`);
    await addPhotos(page, [PHOTOS.portrait]);
    await expect(cards(page)).toHaveCount(1);
    const download = page.getByRole('button', { name: 'Download', exact: true });
    await download.click();
    const options = page.getByRole('dialog', { name: 'Ready to Download?' });
    await options.getByRole('checkbox').first().check();
    await options.getByRole('button', { name: /Imposition/ }).click();
    const sheets = page.getByRole('dialog', { name: 'Print settings' });
    const close = sheets.getByRole('button', { name: 'Close' });
    await expect(close).toBeFocused();
    // One sheet, so no sheet arrows: Close is the first control and Download the last.
    await page.keyboard.press('Shift+Tab');
    await expect(sheets.getByRole('button', { name: /^Download (\d+ )?print sheets?$/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheets).toBeHidden();
    await expect(download).toBeFocused();
  });
});
