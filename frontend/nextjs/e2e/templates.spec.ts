import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';
import {
  E2E_TEMPLATE_PREFIX, createEmbedSession, createTemplate, hideTemplate, printArchive, rememberOrder, uploadSticker,
} from './support/api';
import { signIn } from './support/auth';
import { PARENT_ORIGIN, e2eEnv } from './support/env';
import { PHOTOS, addPhotos, cards, layoutName, openEmbedEditor, openInParentPage, startParentServer } from './support/editor';
import { solidPng } from './support/png';

/**
 * Layout templates, end to end: ops decoration (a text line and a sticker)
 * made through the API, then picked by a customer on the dashboard and in the
 * embed, and finally rendered by the server with the sticker found at its
 * place in the 300-DPI print file.
 */

const TEMPLATE_ID = `${E2E_TEMPLATE_PREFIX}${Date.now()}-${process.pid}`;
const TEMPLATE_NAME = `E2E Template ${process.pid}`;
// Pure green, so the print check can tell the sticker from any photo.
const STICKER_RGB: [number, number, number] = [0, 200, 0];

type Saved = { editor_state?: { surfaces?: Array<{ canvases?: Array<{ overlays?: Array<{ type: string; templateId?: string }> }> }> } };

function recordTemplateAutosaves(page: Page): Saved[] {
  const saves: Saved[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'PUT' && /\/canvas-state\/[^/]+\/$/.test(new URL(r.url()).pathname) && r.ok()) {
      saves.push(JSON.parse(r.request().postData() || '{}'));
    }
  });
  return saves;
}

const templateOverlayTypes = (s: Saved | undefined) =>
  (s?.editor_state?.surfaces?.[0]?.canvases?.[0]?.overlays ?? [])
    .filter((o) => o.templateId === TEMPLATE_ID).map((o) => o.type).sort();

const picker = (surface: Page | ReturnType<Page['frameLocator']>) => surface.getByRole('dialog', { name: 'Choose a template' });

test.describe('layout templates', () => {
  test.beforeAll(async () => {
    const sticker = await uploadSticker(solidPng(64, 64, STICKER_RGB));
    await createTemplate({
      id: TEMPLATE_ID,
      layout: layoutName(),
      displayName: TEMPLATE_NAME,
      decoration: { surfaces: { default: { bgColor: '#fff4e6', overlays: [
        { type: 'text', id: 't1', text: 'Happy Birthday', x: 50, y: 8, fontSize: 60, color: '#64318e', fontFamily: 'Inter', textAlign: 'center', rotation: 0 },
        // Covers the middle fifth of the card: x/y 40%, size 20%.
        { type: 'image', id: 's1', source: 'clipart', src: sticker, label: 'e2e sticker', x: 40, y: 40, width: 20, height: 20, rotation: 0, opacity: 1 },
      ] } } },
    });
  });

  test.afterAll(async () => {
    await hideTemplate(TEMPLATE_ID);
  });

  test('dashboard: the layout card counts its templates, and a fresh design starts with the picker', async ({ context, page }) => {
    await signIn(context, 'editor');
    await page.goto('/dashboard');
    const card = page.locator(`a[href="/editor/layout/${layoutName()}"]`).first();
    await expect(card).toContainText(/\d+ Templates?/);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/editor/layout/${layoutName()}`));
    const orderId = new URL(page.url()).searchParams.get('order_id');
    if (orderId) rememberOrder(orderId);

    const saves = recordTemplateAutosaves(page);
    const dialog = picker(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Start with a template')).toBeVisible();
    await dialog.getByRole('button', { name: TEMPLATE_NAME }).click();
    await expect(dialog).toBeHidden();

    await addPhotos(page, [PHOTOS.portrait]);
    await expect(cards(page)).toHaveCount(1);
    // The card was created with the template's text and sticker on it.
    await expect.poll(() => templateOverlayTypes(saves.at(-1)), { timeout: 30_000 }).toEqual(['image', 'text']);
  });

  test('embed: template_flow asks first; without it the customer is not asked', async ({ page }) => {
    const asked = await createEmbedSession({ templateFlow: true });
    expect(asked.embedUrlTemplate).toMatch(/&template_flow=1$/);
    await page.goto(asked.embedUrlTemplate.replace('{layout_name}', encodeURIComponent(layoutName())));
    const dialog = picker(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Start blank' }).first().click();
    await expect(dialog).toBeHidden();
    // Still reachable from the toolbar.
    await page.getByRole('button', { name: 'Templates' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: TEMPLATE_NAME })).toBeVisible();
    await dialog.getByRole('button', { name: 'Start blank' }).first().click();
    await expect(dialog).toBeHidden();

    const notAsked = await createEmbedSession();
    await openEmbedEditor(page, notAsked.token);
    await expect(page.getByRole('button', { name: 'Templates' })).toBeVisible();
    await expect(picker(page)).toHaveCount(0);
  });

  test('embed: template_id opens on the template, and the print file carries the sticker', async ({ page }) => {
    test.skip(process.env.E2E_WORKERS === '0', 'No Celery worker is running, so a render cannot complete (see e2e/README.md).');
    const stopParent = await startParentServer(Number(new URL(PARENT_ORIGIN).port));
    try {
      const session = await createEmbedSession({ templateId: TEMPLATE_ID });
      expect(session.editorUrl).toBe(
        `/editor/layout/${layoutName()}?token=${session.token}&template=${TEMPLATE_ID}`,
      );
      const { baseUrl } = e2eEnv();
      const frame = await openInParentPage(page, `${baseUrl}${session.editorUrl}`);
      await expect(picker(frame)).toHaveCount(0);
      await addPhotos(frame, [PHOTOS.portrait]);
      await expect(cards(frame)).toHaveCount(1);

      // Near its left edge: in a 1300 px iframe the toolbar, with its Templates
      // button, runs past the frame's right edge and cuts this button in half.
      await frame.getByRole('button', { name: 'Save and continue' }).click({ position: { x: 8, y: 8 } });
      const confirm = frame.getByRole('dialog', { name: 'Ready to Submit?' });
      await confirm.getByRole('checkbox').check();
      const renderResponse = page.waitForResponse(
        (r) => r.url().endsWith('/api/embed/proxy/editor/render') && r.request().method() === 'POST', { timeout: 90_000 },
      );
      await confirm.getByRole('button', { name: 'Yes, Proceed' }).click();
      const res = await renderResponse;
      expect(res.status()).toBe(202);
      const body = JSON.parse(res.request().postData() || '{}');
      const overlays: Array<{ type: string; templateId?: string; fileId?: string }> = body.canvases[0].overlays;
      const sticker = overlays.find((o) => o.type === 'image' && o.templateId === TEMPLATE_ID);
      // The sticker travels as an uploaded raster, like an icon.
      expect(sticker?.fileId).toMatch(/^[0-9a-f-]{36}$/);
      expect(overlays.some((o) => o.type === 'text' && o.templateId === TEMPLATE_ID)).toBe(true);

      const { job_id: jobId } = await res.json();
      const zip = await JSZip.loadAsync(await printArchive(jobId));
      const pngName = Object.keys(zip.files).find((n) => /\.png$/i.test(n));
      expect(pngName).toBeTruthy();
      const png = await zip.file(pngName!)!.async('base64');
      // Decode in the browser and read the middle of the print, which the sticker covers.
      const centre = await page.evaluate(async (b64) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bmp, 0, 0);
        return Array.from(ctx.getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2), 1, 1).data.slice(0, 3));
      }, png);
      // The sticker's own colour, give or take resampling. The test photo has
      // bright greens of its own, so a loose "is it green" would not prove it.
      centre.forEach((v, i) => expect(Math.abs(v - STICKER_RGB[i]), `centre pixel ${centre.join(',')}`).toBeLessThanOrEqual(20));
    } finally {
      await stopParent();
    }
  });
});

