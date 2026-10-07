import { expect, test } from '@playwright/test';
import { createEmbedSession } from './support/api';
import { PARENT_ORIGIN, e2eEnv } from './support/env';
import {
  PHOTOS, addPhotos, canvasCount, canvasStateFetches, cards, layoutName, logCanvasStateFetches,
  openEmbedEditor, openInParentPage, parentMessages, parentPageUrl, recordAutosaves, startParentServer,
} from './support/editor';

test.describe('embed editor (customer iframe)', () => {
  test('photos append, the design autosaves, and a refresh restores it with the photos', async ({ page }) => {
    const { token } = await createEmbedSession();
    const saves = recordAutosaves(page);
    await openEmbedEditor(page, token);
    await addPhotos(page, [PHOTOS.portrait, PHOTOS.landscape]);
    await expect(cards(page)).toHaveCount(2);
    await addPhotos(page, [PHOTOS.square]);
    await expect(cards(page)).toHaveCount(3);
    await expect.poll(() => canvasCount(saves.at(-1)), { timeout: 30_000 }).toBe(3);
    // Real thumbnails: the browser actually rendered each card.
    for (const card of await cards(page).all()) {
      await expect(card.locator('img').first()).toHaveJSProperty('complete', true);
      expect(await card.locator('img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    }

    await page.reload();
    await expect(cards(page)).toHaveCount(3);
    await expect(page.getByText('Photo missing — tap to re-upload')).toHaveCount(0);
  });

  test('a slow restore is never overwritten by autosave (PR #166)', async ({ page }) => {
    const { token } = await createEmbedSession();
    const saves = recordAutosaves(page);
    await openEmbedEditor(page, token);
    await addPhotos(page, [PHOTOS.portrait, PHOTOS.square]);
    await expect.poll(() => canvasCount(saves.at(-1)), { timeout: 30_000 }).toBe(2);

    // Reload with the restore GET held for 5 s — well past the 2 s autosave debounce.
    await logCanvasStateFetches(page);
    await page.route(/\/api\/embed\/proxy\/canvas-state\/[^/]+\/$/, async (route) => {
      if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 5000));
      await route.continue();
    });
    const savesBefore = saves.length;
    await page.reload();
    await expect(cards(page)).toHaveCount(2, { timeout: 30_000 });
    await page.waitForTimeout(3000);

    const log = await canvasStateFetches(page);
    const get = log.find((e) => e.method === 'GET');
    expect(get?.end).toBeTruthy();
    for (const put of log.filter((e) => e.method === 'PUT')) {
      expect(put.start, 'autosave issued while the restore was still in flight').toBeGreaterThanOrEqual(get!.end!);
    }
    for (const s of saves.slice(savesBefore)) expect(canvasCount(s)).toBe(2);
  });

  test('ordered quantity: over-picks are held at "Keep first N"; under-picks warn but can submit', async ({ page }) => {
    const over = await createEmbedSession({ qty: 2 });
    await openEmbedEditor(page, over.token);
    await addPhotos(page, [PHOTOS.portrait, PHOTOS.landscape, PHOTOS.square]);
    const dialog = page.getByRole('alertdialog', { name: 'More images than ordered' });
    await expect(dialog).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    await dialog.getByRole('button', { name: /Keep first 2/i }).click();
    await expect(cards(page)).toHaveCount(2);

    const under = await createEmbedSession({ qty: 3 });
    await openEmbedEditor(page, under.token);
    await addPhotos(page, [PHOTOS.portrait]);
    await expect(page.getByText('1 of 3 images uploaded')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save and continue' })).toBeEnabled();
  });

  test('inside the storefront: Back and Save & Continue message the parent; the render is accepted', async ({ page }) => {
    const stopParent = await startParentServer(Number(new URL(PARENT_ORIGIN).port));
    try {
      const { token, orderId } = await createEmbedSession();
      const { baseUrl } = e2eEnv();
      const editorOrigin = new URL(baseUrl).origin;
      const editorDoc = page.waitForResponse((r) => r.url().includes(`/editor/layout/`) && r.request().resourceType() === 'document');
      const frame = await openInParentPage(page, `${baseUrl}/editor/layout/${encodeURIComponent(layoutName())}?token=${encodeURIComponent(token)}`);
      const csp = (await editorDoc).headers()['content-security-policy'] || '';
      expect(csp).toContain('frame-ancestors');
      expect(csp).toContain('https://printo.in');
      expect(csp).toContain('https://*.printo.in');
      await addPhotos(frame, [PHOTOS.portrait, PHOTOS.landscape]);
      await expect(cards(frame)).toHaveCount(2);

      await frame.getByRole('button', { name: 'Back', exact: true }).click();
      await expect.poll(async () => (await parentMessages(page)).map((m) => m.data.type)).toContain('pe:back');
      const back = (await parentMessages(page)).find((m) => m.data.type === 'pe:back')!;
      expect(back).toEqual({ origin: editorOrigin, data: { type: 'pe:back', orderID: orderId } });

      await frame.getByRole('button', { name: 'Save and continue' }).click();
      const confirm = frame.getByRole('dialog', { name: 'Ready to Submit?' });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('checkbox').check();
      const renderResponse = page.waitForResponse((r) => r.url().endsWith('/api/embed/proxy/editor/render') && r.request().method() === 'POST', { timeout: 90_000 });
      await confirm.getByRole('button', { name: 'Yes, Proceed' }).click();
      const res = await renderResponse;
      expect(res.status()).toBe(202);
      const { job_id: jobId } = await res.json();
      const body = JSON.parse(res.request().postData() || '{}');
      expect(body.layout_name).toBe(layoutName());
      expect(body.canvases).toHaveLength(2);
      for (const c of body.canvases) expect(c.frames[0].upload_id).toMatch(/^[0-9a-f-]{36}$/);

      await expect.poll(async () => (await parentMessages(page)).map((m) => m.data.type)).toContain('pe:render_job');
      const done = (await parentMessages(page)).find((m) => m.data.type === 'pe:render_job')!;
      expect(done).toEqual({ origin: editorOrigin, data: { type: 'pe:render_job', jobId, orderID: orderId } });
    } finally {
      await stopParent();
    }
  });

  test('a site that is not printo.in cannot embed the editor', async ({ page }) => {
    const { token } = await createEmbedSession();
    const { baseUrl } = e2eEnv();
    const refusals: string[] = [];
    page.on('console', (m) => { if (/frame-ancestors/.test(m.text())) refusals.push(m.text()); });
    // A real local server, so only frame-ancestors (not Chrome's local-network checks) can refuse it.
    const outsider = 'http://127.0.0.1:3998';
    const stopOutsider = await startParentServer(3998);
    try {
      await page.goto(parentPageUrl(outsider, `${baseUrl}/editor/layout/${encodeURIComponent(layoutName())}?token=${encodeURIComponent(token)}`));
      await expect.poll(() => refusals.length, { timeout: 20_000 }).toBeGreaterThan(0);
      await expect(page.frameLocator('#pe').locator('input[type="file"][multiple]')).toHaveCount(0);
    } finally {
      await stopOutsider();
    }
  });

  test('an iPhone HEIC photo is converted and lands on the canvas', async ({ page }) => {
    const { token } = await createEmbedSession();
    await openEmbedEditor(page, token);
    await addPhotos(page, [PHOTOS.heic]);
    await expect(cards(page)).toHaveCount(1, { timeout: 60_000 });
  });

  test('the canvas editor opens on a card and closes again', async ({ page }) => {
    const { token } = await createEmbedSession();
    await openEmbedEditor(page, token);
    await addPhotos(page, [PHOTOS.portrait]);
    await cards(page).first().click();
    const editor = page.getByRole('dialog', { name: 'Canvas editor' });
    await expect(editor).toBeVisible();
    await expect(editor.locator('canvas').first()).toBeVisible();
    await editor.getByRole('button', { name: 'Close editor' }).click();
    await expect(editor).toBeHidden();
    await expect(cards(page)).toHaveCount(1);
  });
});
