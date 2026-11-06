import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';
import {
  E2E_LAYOUT_PREFIX, E2E_TEMPLATE_PREFIX, createEmbedSession, createLayout, deleteLayout, getLayout, getTemplate, hideTemplate,
  printArchive, setTemplateStatus, stickerText,
} from './support/api';
import { signIn } from './support/auth';
import { PHOTOS, addPhotos, cards } from './support/editor';

/**
 * Importing a design made in the older design tool, end to end, both ways.
 *
 * Onto a size: ops choose a size and paste the JSON; every picture becomes one
 * artwork on the chosen layout, no layout is created, the template editor opens
 * on it, and a real render shows the artwork centred with the hole at that
 * layout's print area.
 *
 * Its own layout, when no layout has as many print areas as the design has
 * photo spaces: Confirm creates the layout and opens it in the layout editor,
 * where the test narrows the print area and presses Update Layout. Back on the
 * Templates page the artwork is cut to the print area as saved and the template
 * editor opens on the design. The layout and the template are then read back
 * from the server, and a real render's print file is read where the page colour,
 * the artwork under the photo, the hole cut for the photo (as saved, not as
 * imported) and the picture drawn over the photo layer should be.
 *
 * The design's artwork files are answered by the test: the old tool's file
 * host is not something a test should depend on, and the server will only
 * fetch from a public host an administrator listed. Everything else is the
 * real app and the real server. The server's own fetch is covered by
 * api/tests/test_design_import.py and services/tests/test_design_import.py.
 */

const RUN = `${Date.now()}_${process.pid}`;
const LAYOUT = `${E2E_LAYOUT_PREFIX}import_${RUN}`;
const RACE_LAYOUT = `${E2E_LAYOUT_PREFIX}import_race_${RUN}`;
/** Two print areas, so a one-photo design has to make its own layout. */
const TWO_AREAS = `${E2E_LAYOUT_PREFIX}import_two_${RUN}`;
/** One print area on a bigger canvas: a design is placed on it, centred. */
const ON_SIZE = `${E2E_LAYOUT_PREFIX}import_size_${RUN}`;
const SIZE_TEMPLATE_NAME = `E2E Import Size ${RUN.replace('_', ' ')}`;
const SIZE_TEMPLATE_ID = `${E2E_TEMPLATE_PREFIX}import-size-${RUN.replace('_', '-')}`;
// The editor makes the template's id from its name.
const TEMPLATE_NAME = `E2E Import ${RUN.replace('_', ' ')}`;
const TEMPLATE_ID = `${E2E_TEMPLATE_PREFIX}import-${RUN.replace('_', '-')}`;

// Colours no photo is likely to hold at the pixels read.
const PAPER = '#f599a6';
const BLOCK_RGB: [number, number, number] = [200, 0, 200];
const STICKER_RGB: [number, number, number] = [0, 0, 200];
const STICKER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0000c8"/></svg>';
// The old tool's frame overlay: drawn over its whole 7 x 9 in canvas, open in the middle.
const FRAME_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 900"><path fill="#727272" fill-rule="evenodd" d="M0 0h700v900H0z M80 80h540v740H80z"/></svg>';

type Obj = Record<string, unknown>;
// The old canvas is 7 x 9 in drawn 177.8 units wide, so one unit is one
// millimetre; the 6 x 8 in print area starts 12.7 mm in.
const MARGIN = 12.7;
const at = (x: number, y: number) => ({ left: x + MARGIN, top: y + MARGIN, scaleX: 1, scaleY: 1, angle: 0, opacity: 1 });
const WINDOW: Obj = { type: 'mask', element: 'rectangle', width: 100.4, height: 88, ...at(26, 46) };
/** A colour block listed before the window and 6 mm bigger all round: it sits under the photo. */
const BLOCK: Obj = {
  type: 'image', objType: 'vectorImage', fill: '#c800c8', width: 112.4, height: 100, ...at(20, 40),
  src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect data-custom-shape="rect" width="10" height="10" fill="#c800c8"/></svg>',
};
/** The window's width once the test has narrowed it in the layout editor: 10 mm off its right side. */
const SAVED_WIDTH = 90.4;
/** Listed after the window and clear of it: it joins the page artwork, drawn over the photo layer. */
const STICKER: Obj = { type: 'image', objType: 'vectorImage', src: 'https://files.e2e.invalid/site/sticker.svg', width: 30, height: 30, ...at(110, 150) };
const TEXT: Obj = {
  type: 'textbox', text: 'E2E imported', fontFamily: 'Inter', fontSize: 8, fontWeight: 'normal', fontStyle: 'normal', textAlign: 'left',
  fill: '#302a18', width: 100, height: 10, ...at(15, 12),
};

function exportOf(objects: Obj[]): string {
  return JSON.stringify([
    {
      design_mode: 'online_canvas',
      customized_locations_map: {
        '40': {
          customization_data: JSON.stringify({ clockwise_rotation_degree: 0, widthPixels: 177.8, heightPixels: 228.6, objects, printableAreaFill: PAPER }),
          design_canvas_id: 565,
        },
      },
    },
    {
      '565': {
        measuring_unit: 'inch', canvas_width: 7, canvas_height: 9, name: 'Photo Frame | 6 x 8 in',
        overlay_image_url: 'https://files.e2e.invalid/site/frame.svg',
        objects: [{ behavior_type: 'printable_area', shape: 'rectangle', width: 6, height: 8, left_margin: 0.5, top_margin: 0.5, has_bleed_area: false }],
      },
    },
  ]);
}

/** Answer the dialog's artwork requests with the test's own files. */
async function answerArtwork(page: Page) {
  await page.route('**/api/internal/proxy/ops/import/artwork', async (route) => {
    const url = String((route.request().postDataJSON() as { url?: string } | null)?.url ?? '');
    if (url.endsWith('/sticker.svg')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: STICKER_SVG });
    if (url.endsWith('/frame.svg')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: FRAME_SVG });
    return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: 'Not one of the test files.' }) });
  });
}

const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Import a design' });
/** The review's confirm button. */
const CONFIRM = 'Create the layout and adjust it';

const CONTINUE = 'Continue to the template editor';

const TWO_AREA_LAYOUT = {
  canvas: { width: 1800, height: 1200, widthMm: 152.4, heightMm: 101.6, dpi: 300 },
  frames: [{ x: 0.05, y: 0.1, width: 0.4, height: 0.8 }, { x: 0.55, y: 0.1, width: 0.4, height: 0.8 }],
};

/** Pick a layout in the dialog's size picker, whichever size it is listed under. */
async function chooseLayout(page: Page, name: string) {
  const sizes = await page.locator('#import-template-size option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  for (const size of sizes) {
    await page.locator('#import-template-size').selectOption(size);
    if (await page.locator(`#import-template-layout option[value="${name}"]`).count()) {
      await page.locator('#import-template-layout').selectOption(name);
      return;
    }
  }
  throw new Error(`layout ${name} is not offered in the size picker`);
}

/** Open the dialog, optionally choose a layout, paste a design and press Read. */
async function readDesign(page: Page, text: string, layout?: string) {
  await page.getByRole('button', { name: 'Import a design' }).click();
  const dialog = dialogOf(page);
  if (layout) await chooseLayout(page, layout);
  await dialog.getByLabel('Design JSON').fill(text);
  await dialog.getByRole('button', { name: 'Read the design' }).click();
  return dialog;
}

/** Print pixels per millimetre at 300 dpi. */
const px = (mm: number) => Math.round((mm / 25.4) * 300);
const far = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0);

/** Render one photo with a template through the embed and read the print file at these points. */
async function renderAndRead(page: Page, templateId: string, points: number[][]) {
  await setTemplateStatus(templateId, 'published');
  const session = await createEmbedSession({ templateId });
  await page.goto(session.editorUrl!);
  await addPhotos(page, [PHOTOS.portrait]);
  await expect(cards(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'Save and continue' }).click();
  const confirm = page.getByRole('dialog', { name: 'Ready to Submit?' });
  await confirm.getByRole('checkbox').check();
  const renderResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/embed/proxy/editor/render') && r.request().method() === 'POST', { timeout: 90_000 },
  );
  await confirm.getByRole('button', { name: 'Yes, Proceed' }).click();
  const res = await renderResponse;
  expect(res.status()).toBe(202);
  const { job_id: jobId } = await res.json();

  const zip = await JSZip.loadAsync(await printArchive(jobId));
  const pngName = Object.keys(zip.files).find((n) => /\.png$/i.test(n));
  expect(pngName).toBeTruthy();
  const png = await zip.file(pngName!)!.async('base64');
  return page.evaluate(async ({ b64, points: pts }) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    return { size: [bmp.width, bmp.height], at: pts.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3))) };
  }, { b64: png, points });
}

test.describe.serial('importing a design from the old design tool', () => {
  test.afterAll(async () => {
    await hideTemplate(TEMPLATE_ID);
    await hideTemplate(SIZE_TEMPLATE_ID);
    for (const name of [LAYOUT, RACE_LAYOUT, TWO_AREAS, ON_SIZE]) await deleteLayout(name);
  });

  test('onto a size: one artwork on the chosen layout, no layout created, centred, with the hole at its print area', async ({ context, page }) => {
    test.skip(process.env.E2E_WORKERS === '0', 'No Celery worker is running, so a render cannot complete (see e2e/README.md).');
    await signIn(context, 'ops');
    await answerArtwork(page);
    // 200 x 250 mm, so the 152.4 x 203.2 mm page sits 23.8 mm in and 23.4 mm down. The print area is 60, 80, 80 x 70.
    await createLayout(ON_SIZE, {
      canvas: { width: 2362, height: 2953, widthMm: 200, heightMm: 250, dpi: 300 },
      frames: [{ x: 0.3, y: 0.32, width: 0.4, height: 0.28, xMm: 60, yMm: 80, widthMm: 80, heightMm: 70, bleedMm: 0 }],
    });
    await page.goto('/editor/layouts/templates');
    const layoutWrites: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/ops/layouts')) layoutWrites.push(r.url()); });
    const dialog = await readDesign(page, exportOf([BLOCK, WINDOW, STICKER, TEXT]), ON_SIZE);

    const go = dialog.getByRole('button', { name: CONTINUE });
    await expect(go).toBeEnabled();
    await expect(dialog.getByText(/Mapped to size:/)).toBeVisible();
    await expect(dialog.getByLabel(/Artwork size/)).toBeVisible();
    await expect(dialog.getByLabel(/Layout id/)).toHaveCount(0);
    await dialog.getByLabel('Template name').fill(SIZE_TEMPLATE_NAME);
    await go.click();

    await expect(page).toHaveURL(new RegExp(`/editor/layouts/templates/${ON_SIZE}/new\\?import=1&tick=size`), { timeout: 60_000 });
    await expect(page.locator('#template-id')).toHaveValue(SIZE_TEMPLATE_ID);
    expect(layoutWrites).toEqual([]);
    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page).toHaveURL(new RegExp(`/editor/layouts/templates/${ON_SIZE}/${SIZE_TEMPLATE_ID}$`), { timeout: 60_000 });

    const side = (await getTemplate(SIZE_TEMPLATE_ID))!.decoration.surfaces.default;
    expect(side.overlays.map((o) => [o.type, o.label ?? o.text])).toEqual([['image', 'Artwork'], ['text', 'E2E imported']]);
    expect(side.overlays[0]).toMatchObject({ x: 0, y: 0, width: 100, height: 100 });

    const read = await renderAndRead(page, SIZE_TEMPLATE_ID, [
      [px(5), px(5)],        // outside the old page: the page colour
      [px(50), px(100)],     // the colour block, left of the print area
      [px(100), px(115)],    // the middle of the print area
      [px(148.8), px(188.4)], // the middle of the sticker, moved with the page
    ]);
    const [paper, ring, photo, sticker] = read.at;
    expect(far(paper, [245, 153, 166]), `page colour, got ${paper}`).toBeLessThanOrEqual(30);
    expect(far(ring, BLOCK_RGB), `colour block, got ${ring}`).toBeLessThanOrEqual(30);
    expect(far(sticker, STICKER_RGB), `sticker, got ${sticker}`).toBeLessThanOrEqual(30);
    expect(far(photo, BLOCK_RGB), `photo in the print area, got ${photo}`).toBeGreaterThan(90);
    expect(far(photo, [245, 153, 166]), `photo in the print area, got ${photo}`).toBeGreaterThan(90);
  });

  test('its own layout: confirm; the layout is adjusted in its editor; the template editor opens on the design cut to it', async ({ context, page }) => {
    await signIn(context, 'ops');
    await answerArtwork(page);
    await createLayout(TWO_AREAS, TWO_AREA_LAYOUT);
    await page.goto('/editor/layouts/templates');
    const dialog = await readDesign(page, exportOf([BLOCK, WINDOW, STICKER, TEXT]), TWO_AREAS);

    // A layout with another number of print areas cannot take it, and the dialog says so.
    await expect(dialog.getByRole('button', { name: CONTINUE })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toContainText('has 1 photo space, but this layout has 2 print areas');
    await dialog.getByRole('button', { name: 'Make a new layout for this design' }).click();

    // The review: what it becomes, before anything is created.
    const confirm = dialog.getByRole('button', { name: CONFIRM });
    await expect(confirm).toBeEnabled();
    await expect(dialog.getByLabel(/Layout id/)).toHaveValue(/^photo_frame_6x8_1_photo/);
    await expect(dialog.getByText('1 photo window becomes a print area of the new layout.')).toBeVisible();
    await expect(dialog.getByText(/2 pictures become the page artwork/)).toBeVisible();
    await expect(dialog.getByText(`Page colour ${PAPER}.`)).toBeVisible();
    await expect(dialog.getByLabel(/Use the old tool.s frame/)).toBeChecked();
    expect(await getLayout(LAYOUT)).toBeNull();

    await dialog.getByLabel(/Layout id/).fill(LAYOUT);
    await dialog.getByLabel('Layout name').fill(`E2E import ${RUN}`);
    await dialog.getByLabel('Template name').fill(TEMPLATE_NAME);
    const layoutWrite = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/internal/proxy/ops/layouts/${LAYOUT}`));
    await confirm.click();
    // The layout is written so that it can never replace one that exists.
    expect((await layoutWrite).postDataBuffer()?.toString('latin1')).toMatch(/name="create_only"\r\n\r\n1\r\n/);

    // Confirm opens the new layout in the layout editor, with the design's pictures behind its print area.
    await expect(page).toHaveURL(/\/editor\/layouts(\?.*)?$/, { timeout: 60_000 });
    await expect(page.getByRole('status').filter({ hasText: 'Imported design.' })).toContainText('its pictures are shown behind them');
    await expect(page.getByPlaceholder('e.g. classic_print_4x6')).toHaveValue(LAYOUT);

    // The layout as the server holds it so far: the print area as the canvas, the window as its print area, the frame as a PNG.
    const created = await getLayout(LAYOUT);
    expect(created?.canvas).toMatchObject({ width: 1800, height: 2400, widthMm: 152.4, heightMm: 203.2 });
    expect(created?.frames).toHaveLength(1);
    expect(created?.frames[0]).toMatchObject({ xMm: 26, yMm: 46, widthMm: 100.4, heightMm: 88, bleedMm: 0 });
    expect(created?.frameMaskUrl).toMatch(/\.png$/);

    // Ops put the print area right before any artwork exists: here it loses 10 mm on its right.
    await page.getByRole('radiogroup', { name: 'Measurement unit' }).getByRole('radio', { name: 'mm' }).click();
    await page.getByTitle('W (mm)', { exact: true }).fill(String(SAVED_WIDTH));
    await page.getByRole('button', { name: 'Update Layout' }).click();

    // Saving goes back to the Templates page, where the artwork is cut to the saved print area
    // and the template editor opens on the design. Nothing is a template yet.
    await expect(page).toHaveURL(new RegExp(`/editor/layouts/templates/${LAYOUT}/new\\?import=1$`), { timeout: 90_000 });
    await expect(page.getByText('Imported design.')).toBeVisible();
    await expect(page.locator('#template-display-name')).toHaveValue(TEMPLATE_NAME);
    await expect(page.locator('#template-id')).toHaveValue(TEMPLATE_ID);
    await expect(page.getByRole('list', { name: 'Sides' }).locator('img').first()).toBeVisible();
    expect(await getTemplate(TEMPLATE_ID)).toBeNull();
    // The save kept the rest of the layout: the canvas, where the print area starts, and the frame picture.
    const saved = await getLayout(LAYOUT);
    expect(saved?.canvas).toMatchObject({ width: 1800, height: 2400, widthMm: 152.4, heightMm: 203.2 });
    expect(saved?.frames).toHaveLength(1);
    expect(saved?.frames[0]).toMatchObject({ xMm: 26, yMm: 46, widthMm: SAVED_WIDTH, heightMm: 88 });
    expect(saved?.frameMaskUrl).toMatch(/\.png$/);

    await page.getByRole('button', { name: 'Create template' }).click();
    await expect(page).toHaveURL(new RegExp(`/editor/layouts/templates/${LAYOUT}/${TEMPLATE_ID}$`), { timeout: 60_000 });

    // The template: the page colour, one page artwork over the whole sheet, and the text above it.
    const template = await getTemplate(TEMPLATE_ID);
    expect(template?.layoutName).toBe(LAYOUT);
    const side = template!.decoration.surfaces.default;
    expect(side.paperColor).toBe(PAPER);
    expect(side.overlays.map((o) => [o.type, o.label ?? o.text])).toEqual([['image', 'Artwork'], ['text', 'E2E imported']]);
    expect(side.overlays[0]).toMatchObject({ source: 'clipart', x: 0, y: 0, width: 100, height: 100 });
    expect(side.overlays[1]).toMatchObject({ fontFamily: 'Inter', textAlign: 'left', color: '#302a18' });
    // Every picture is in that one artwork, still a vector: the block with a hole for the print area, and the sticker's own drawing.
    const artwork = await stickerText(String(side.overlays[0].src));
    expect(artwork).toContain('clip-rule="evenodd"');
    expect(artwork).toContain('data-custom-shape="rect"');
    expect(artwork).toContain('fill="#0000c8"');
  });

  test('the print carries the page colour, the artwork with a hole cut to the saved print area, and the sticker; never the frame', async ({ page }) => {
    test.skip(process.env.E2E_WORKERS === '0', 'No Celery worker is running, so a render cannot complete (see e2e/README.md).');
    const spots = {
      paper: [px(5), px(5)],            // a corner the frame covers in previews: the print has the page colour there
      ring: [px(23), px(90)],           // the colour block, between its edge and the print area
      photo: [px(71.2), px(90)],        // the middle of the print area as saved
      narrowed: [px(121), px(90)],      // inside the window as imported, outside the print area as saved
      sticker: [px(125), px(165)],      // the middle of the sticker
    };
    const read = await renderAndRead(page, TEMPLATE_ID, Object.values(spots));
    expect(read.size).toEqual([1800, 2400]);
    const [paper, ring, photo, narrowed, sticker] = read.at;
    expect(far(paper, [245, 153, 166]), `page colour at the corner, got ${paper}`).toBeLessThanOrEqual(30);
    expect(far(ring, BLOCK_RGB), `the colour block around the print area, got ${ring}`).toBeLessThanOrEqual(30);
    // The hole follows the print area as saved in the layout editor, not the window as imported:
    // the 10 mm taken off it are colour block, where an artwork cut before the save would show the photo.
    expect(far(narrowed, BLOCK_RGB), `the colour block where the print area was narrowed, got ${narrowed}`).toBeLessThanOrEqual(30);
    expect(far(sticker, STICKER_RGB), `the sticker, got ${sticker}`).toBeLessThanOrEqual(30);
    // The photo shows through the hole: neither the block nor the page colour.
    expect(far(photo, BLOCK_RGB), `the photo in the window, got ${photo}`).toBeGreaterThan(90);
    expect(far(photo, [245, 153, 166]), `the photo in the window, got ${photo}`).toBeGreaterThan(90);
  });

  test('an import never replaces a layout that appeared after the page loaded', async ({ context, page }) => {
    await signIn(context, 'ops');
    await answerArtwork(page);
    await page.goto('/editor/layouts/templates');
    await expect(page.getByRole('button', { name: 'Import a design' })).toBeEnabled();
    // Someone else creates a layout under the name while this page is open: the page's own list cannot know.
    await createLayout(RACE_LAYOUT, TWO_AREA_LAYOUT);

    // The sizes on the page predate it, so a layout with another number of print areas is what makes this design need its own.
    const dialog = await readDesign(page, exportOf([BLOCK, WINDOW]), TWO_AREAS);
    await dialog.getByRole('button', { name: 'Make a new layout for this design' }).click();
    await dialog.getByLabel(/Layout id/).fill(RACE_LAYOUT);
    await dialog.getByRole('button', { name: CONFIRM }).click();
    await expect(dialog.getByRole('alert')).toContainText(`A layout named '${RACE_LAYOUT}' already exists`);
    await expect(dialog.getByLabel(/Layout id/)).toBeEnabled();
    // Theirs is as they made it.
    expect((await getLayout(RACE_LAYOUT))?.frames).toHaveLength(2);
  });

  test('says once, before any review, when the server may not fetch the artwork', async ({ context, page }) => {
    await signIn(context, 'ops');
    await page.goto('/editor/layouts/templates');
    // No stand-in here: the real server refuses a host no administrator listed, without fetching anything.
    const dialog = await readDesign(page, exportOf([WINDOW, STICKER]));
    await expect(dialog.getByRole('alert')).toContainText(/Fetching artwork is off for this API key|Artwork can only be fetched from/);
    await expect(dialog.getByRole('button', { name: 'Read the design' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: CONFIRM })).toHaveCount(0);
  });
});
