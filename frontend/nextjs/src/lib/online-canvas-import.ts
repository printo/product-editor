/**
 * Reading a design exported from the older online-canvas design tool and
 * working out what it becomes here: a layout (its photo windows) and a
 * template (everything else). Pure: no network and no DOM. The Templates
 * page's Import dialog (components/ImportDesignDialog.tsx) fetches the
 * artwork, calls the builders below and hands the result to the template
 * editor, where nothing is saved until the ops user presses Save.
 *
 * The export is a JSON array of two objects: the design
 * (`customized_locations_map.<n>.customization_data`, itself a JSON string)
 * and the product canvas it sits on, keyed by its id.
 *
 * Rules, each checked against the old tool's own previews:
 * - one old unit is `canvas inches × 25.4 / widthPixels` mm, and our canvas
 *   is the old printable area (its margins are subtracted);
 * - an object is drawn `width × scaleX × scalingFactorToBringImageIntoPrintableArea`
 *   wide at `left`/`top`;
 * - each `mask` is a photo window;
 * - the old tool stacks windows and artwork in any order, while a photo is
 *   always the bottom layer here. So every picture is merged, in the old
 *   order, into ONE page artwork: a picture listed under a window gets a
 *   hole cut for it, one listed after is drawn over the photo. One sheet,
 *   because only the page artwork lets a click on a see-through part reach
 *   the photo; a sticker of its own is picked up by its whole box, and one
 *   file with hearts on two corners of a photo covered all of it. Text
 *   stays a text of its own, above the artwork;
 * - artwork running off the print area is cropped to it, because an overlay
 *   may not leave the canvas (services/template_decoration.py);
 * - vector artwork stays vector: cropping and holes are done by wrapping the
 *   SVG, never by drawing it to pixels.
 *
 * Anything the samples never showed (a round or tilted window, rotated or
 * mirrored artwork, a second side) is reported, not guessed.
 */

export const IMPORT_DPI = 300;
const MM_PER_INCH = 25.4;
/** A hole sits this far inside its window, so the artwork overlaps the
 *  photo's edge and no hairline of paper shows between them. */
export const HOLE_INSET_MM = 0.3;
/** Differences smaller than this are rounding, not geometry. */
const EPS_MM = 0.05;
/** The server's limit for one sticker (services/template_decoration.py). */
export const MAX_STICKER_BYTES = 5 * 1024 * 1024;
/** A raster placed at fewer dots per inch than this looks soft in print. */
export const LOW_DPI = 150;

const UNIT_MM: Record<string, number> = { inch: MM_PER_INCH, in: MM_PER_INCH, inches: MM_PER_INCH, cm: 10, mm: 1 };

export class DesignImportError extends Error {}

/** A rectangle in millimetres from the print area's top-left corner. */
export interface MmBox { x: number; y: number; w: number; h: number }
export interface ImportedWindow {
  /** Position in the export's object list (its place in the old stacking order). */
  index: number;
  box: MmBox;
}

export interface ImportedText {
  text: string;
  fontFamily: string;
  /** Print pixels at IMPORT_DPI, the unit a text overlay's fontSize is in. */
  fontSizePx: number;
  color: string;
  align: 'left' | 'center' | 'right';
}

export type PieceKind = 'vector' | 'raster' | 'shape' | 'text';

export interface ImportedPiece {
  index: number;
  kind: PieceKind;
  /** As placed in the old design; may run off the print area. */
  box: MmBox;
  /** The part of `box` inside the print area. */
  visible: MmBox;
  overflows: boolean;
  opacity: number;
  locked: boolean;
  /** The https address of the artwork file (vector and raster pieces). */
  src?: string;
  /** The SVG markup of a shape the old tool stored inline (a colour block). */
  inlineSvg?: string;
  color?: string;
  text?: ImportedText;
  /** Windows listed after this piece that it overlaps: each gets a hole. */
  holes: number[];
  /** `artwork`: a picture, merged into the page artwork.
   *  `overlay`: a text of its own, above it. */
  layer: 'artwork' | 'overlay';
  label: string;
}

export interface ImportNote { level: 'info' | 'warning'; text: string }

export interface ImportedDesign {
  productName: string;
  /** The print area: our canvas. */
  printMm: { width: number; height: number };
  canvasPx: { width: number; height: number };
  /** The old tool's whole canvas and where the print area sat on it. */
  oldCanvasMm: { width: number; height: number; marginLeft: number; marginTop: number };
  paperColor: string | null;
  /** In reading order: the order photos fill them. */
  windows: ImportedWindow[];
  /** In the export's stacking order. */
  pieces: ImportedPiece[];
  /** The old frame overlay drawn over the whole old canvas, if any. */
  overlayUrl: string | null;
  facing: 'portrait' | 'landscape' | 'square';
  notes: ImportNote[];
  /** Reasons this design cannot be imported at all; empty when it can. */
  blocked: string[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

const num = (v: unknown, fallback = NaN): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const round = (v: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** Millimetres to print pixels at IMPORT_DPI. */
export const mmToImportPx = (mm: number): number => (mm / MM_PER_INCH) * IMPORT_DPI;

/** `#rrggbb` from a hex or rgb() colour; null for anything else. */
export function hexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return `#${m[1].split('').map(c => c + c).join('').toLowerCase()}`;
  m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return `#${m[1].toLowerCase()}`;
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(v);
  if (m) return `#${[m[1], m[2], m[3]].map(c => Math.min(255, Number(c)).toString(16).padStart(2, '0')).join('')}`;
  return null;
}

const overlaps = (a: MmBox, b: MmBox): boolean =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS_MM
  && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > EPS_MM;

const clip = (b: MmBox, W: number, H: number): MmBox => {
  const x = Math.max(b.x, 0);
  const y = Math.max(b.y, 0);
  return { x, y, w: Math.min(b.x + b.w, W) - x, h: Math.min(b.y + b.h, H) - y };
};

const differs = (a: MmBox, b: MmBox): boolean =>
  Math.abs(a.x - b.x) > EPS_MM || Math.abs(a.y - b.y) > EPS_MM || Math.abs(a.w - b.w) > EPS_MM || Math.abs(a.h - b.h) > EPS_MM;

/**
 * Windows in the order photos should fill them: by rows from the top, left
 * to right within a row. Two windows share a row when their top edges are
 * within a quarter of the shorter one's height; the old tool keeps them in
 * the order they were drawn, which means nothing to a customer.
 */
export function readingOrder<T extends { box: MmBox }>(windows: T[]): T[] {
  const byTop = [...windows].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: T[][] = [];
  for (const w of byTop) {
    const row = rows[rows.length - 1];
    const lead = row?.[0];
    if (lead && w.box.y - lead.box.y <= 0.25 * Math.min(lead.box.h, w.box.h)) row.push(w);
    else rows.push([w]);
  }
  return rows.flatMap(row => row.sort((a, b) => a.box.x - b.box.x));
}

/** The markup of an SVG the old tool stored inline as a data: address. */
export function inlineSvgOf(src: string): string | null {
  const m = /^data:image\/svg\+xml((?:;[^,]*)?),/i.exec(src);
  if (!m) return null;
  const body = src.slice(m[0].length);
  try {
    if (/;base64/i.test(m[1])) return new TextDecoder().decode(base64ToBytes(body));
    return decodeURIComponent(body);
  } catch {
    // A literal % that is not an escape: the text was stored as it is.
    return body;
  }
}

const fileNameOf = (src: string): string => {
  const path = src.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf('/') + 1) || 'artwork';
};

function locate(data: unknown): { design: Json; canvas: Json } {
  const wrong = 'This does not look like an export from the old design tool. Paste the whole text, from the first [ to the last ].';
  if (!Array.isArray(data)) throw new DesignImportError(wrong);
  const designPart = data.find(d => isObj(d) && isObj(d.customized_locations_map)) as Json | undefined;
  if (!designPart) throw new DesignImportError(wrong);
  const locations = Object.values(designPart.customized_locations_map as Json).filter(isObj);
  if (locations.length === 0) throw new DesignImportError('The export holds no design.');
  if (locations.length > 1) {
    throw new DesignImportError(`This design has ${locations.length} sides. Only a single-sided design can be imported for now.`);
  }
  const location = locations[0];
  let design: unknown = location.customization_data;
  if (typeof design === 'string') {
    try { design = JSON.parse(design); } catch { throw new DesignImportError('The design inside the export could not be read.'); }
  }
  if (!isObj(design) || !Array.isArray(design.objects)) throw new DesignImportError('The design inside the export could not be read.');

  const canvases: Json = {};
  for (const part of data) {
    if (!isObj(part) || part === designPart) continue;
    for (const [id, c] of Object.entries(part)) if (isObj(c) && 'canvas_width' in c) canvases[id] = c;
  }
  const wanted = String(location.design_canvas_id ?? '');
  const canvas = (canvases[wanted] ?? Object.values(canvases)[0]) as Json | undefined;
  if (!canvas) throw new DesignImportError('The export does not say which product the design is for (its canvas is missing).');
  return { design, canvas };
}

/**
 * Read the pasted export. Throws DesignImportError (with a message for the
 * ops user) when the text is not an export at all; a design that is one but
 * cannot be imported comes back with `blocked` filled in.
 */
export function parseOnlineCanvasExport(raw: string): ImportedDesign {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    throw new DesignImportError('This is not valid JSON. Paste the whole export, from the first [ to the last ].');
  }
  const { design, canvas } = locate(data);
  const notes: ImportNote[] = [];
  const blocked: string[] = [];

  const unitName = String(canvas.measuring_unit ?? 'inch').toLowerCase();
  const perUnit = UNIT_MM[unitName];
  if (!perUnit) throw new DesignImportError(`The product is measured in '${unitName}', which is not supported.`);
  // Inches times 25.4 leaves float dust (6 in = 152.39999999999998 mm); a tenth of a micron is plenty.
  const canvasW = round(num(canvas.canvas_width) * perUnit, 4);
  const canvasH = round(num(canvas.canvas_height) * perUnit, 4);
  const widthPixels = num(design.widthPixels);
  const heightPixels = num(design.heightPixels);
  if (!(canvasW > 0 && canvasH > 0 && widthPixels > 0 && heightPixels > 0)) {
    throw new DesignImportError('The export does not give the size of the product or of the design.');
  }
  const unit = canvasW / widthPixels;
  if (Math.abs(unit - canvasH / heightPixels) / unit > 0.005) {
    notes.push({ level: 'warning', text: 'The design is not drawn to the same scale across and down; check the positions carefully.' });
  }
  if (num(design.clockwise_rotation_degree, 0) !== 0) blocked.push('The design was drawn on a turned canvas.');

  const areas = Array.isArray(canvas.objects) ? canvas.objects.filter(isObj) : [];
  const area = areas.find(o => o.behavior_type === 'printable_area');
  let W = canvasW, H = canvasH, marginLeft = 0, marginTop = 0;
  if (area) {
    if (String(area.shape ?? 'rectangle').toLowerCase() !== 'rectangle') blocked.push("The product's print area is not a rectangle.");
    W = round(num(area.width) * perUnit, 4);
    H = round(num(area.height) * perUnit, 4);
    if (!(W > 0 && H > 0)) throw new DesignImportError("The export does not give the size of the product's print area.");
    marginLeft = round(num(area.left_margin, (canvasW / perUnit - num(area.width)) / 2) * perUnit, 4);
    marginTop = round(num(area.top_margin, (canvasH / perUnit - num(area.height)) / 2) * perUnit, 4);
    if (area.has_bleed_area) notes.push({ level: 'warning', text: 'The old product has a bleed area. It is not carried over: set the bleed on the print areas if this product needs one.' });
  } else {
    notes.push({ level: 'info', text: 'The export names no print area, so the whole canvas is used.' });
  }

  const boxOf = (o: Json): MmBox => {
    const factor = num(o.scalingFactorToBringImageIntoPrintableArea, 1) || 1;
    return {
      x: num(o.left, 0) * unit - marginLeft,
      y: num(o.top, 0) * unit - marginTop,
      w: num(o.width, 0) * num(o.scaleX, 1) * factor * unit,
      h: num(o.height, 0) * num(o.scaleY, 1) * factor * unit,
    };
  };

  const rawWindows: ImportedWindow[] = [];
  const pieces: ImportedPiece[] = [];
  let skipped = 0;
  (design.objects as unknown[]).forEach((entry, index) => {
    if (!isObj(entry)) return;
    const o = entry;
    const type = String(o.type ?? '').toLowerCase();
    if (o.visible === false) { skipped += 1; return; }
    const box = boxOf(o);
    if (!(box.w > 0 && box.h > 0)) { skipped += 1; return; }
    const tilted = num(o.angle, 0) !== 0;
    const mirrored = o.flipX === true || o.flipY === true;

    if (type === 'mask') {
      if (String(o.element ?? 'rectangle').toLowerCase() !== 'rectangle') blocked.push(`Photo window ${rawWindows.length + 1} is ${String(o.element)}-shaped; only rectangular windows can be imported.`);
      if (tilted) blocked.push(`Photo window ${rawWindows.length + 1} is tilted; only upright windows can be imported.`);
      const inside = clip(box, W, H);
      if (!(inside.w > 0 && inside.h > 0)) { skipped += 1; return; }
      if (differs(inside, box)) notes.push({ level: 'warning', text: `Photo window ${rawWindows.length + 1} ran off the print area and was trimmed to it.` });
      rawWindows.push({ index, box: inside });
      return;
    }

    const visible = clip(box, W, H);
    const opacity = Math.min(1, Math.max(0, num(o.opacity, 1)));
    const base = { index, box, visible, overflows: differs(visible, box), opacity, locked: o.locked === true, holes: [] as number[], layer: 'overlay' as const };

    if (type === 'textbox' || type === 'text' || type === 'i-text') {
      const text = typeof o.text === 'string' ? o.text : '';
      if (!text.trim()) { skipped += 1; return; }
      if (!(visible.w > 0 && visible.h > 0)) { skipped += 1; return; }
      const align = String(o.textAlign ?? 'left').toLowerCase();
      const family = String(o.fontFamily ?? '').trim();
      const weight = String(o.fontWeight ?? 'normal').toLowerCase();
      const label = `Text “${text.length > 28 ? `${text.slice(0, 27)}…` : text}”`;
      if (tilted) notes.push({ level: 'warning', text: `${label} was tilted; it is placed upright.` });
      if (weight === 'bold' || num(o.fontWeight, 400) >= 600 || String(o.fontStyle ?? 'normal').toLowerCase() !== 'normal') {
        notes.push({ level: 'warning', text: `${label} was bold or italic; it is set in the regular cut of the font.` });
      }
      if (text.includes('\n') && Math.abs(num(o.lineHeight, 1.16) - 1.16) > 0.02) {
        notes.push({ level: 'warning', text: `${label} has several lines; the space between them differs slightly from the old design.` });
      }
      pieces.push({
        ...base,
        kind: 'text',
        label,
        text: {
          text,
          fontFamily: family,
          fontSizePx: round(mmToImportPx(num(o.fontSize, 0) * num(o.scaleY, 1) * unit), 1),
          color: hexColor(o.fill) ?? '#000000',
          align: align === 'center' || align === 'right' ? align : 'left',
        },
      });
      return;
    }

    if (type !== 'image') {
      notes.push({ level: 'warning', text: `One object of a kind this import does not know ('${type || 'unnamed'}') was left out.` });
      return;
    }
    if (!(visible.w > 0 && visible.h > 0)) { skipped += 1; return; }
    const src = typeof o.src === 'string' ? o.src : '';
    const inline = src.startsWith('data:') ? inlineSvgOf(src) : null;
    const isShape = inline !== null;
    const name = isShape ? 'Colour block' : fileNameOf(src).replace(/^\d{8}_\d+_[0-9a-f]+_/i, '');
    if (tilted || mirrored) {
      notes.push({ level: 'warning', text: `${name} was ${tilted ? 'tilted' : 'mirrored'} in the old design and was left out: add it by hand in the editor.` });
      return;
    }
    if (isShape) {
      pieces.push({ ...base, kind: 'shape', inlineSvg: inline ?? undefined, color: hexColor(o.fill) ?? undefined, label: name });
      return;
    }
    if (!/^https:\/\//i.test(src)) {
      notes.push({ level: 'warning', text: 'One image has no usable address and was left out.' });
      return;
    }
    const vector = String(o.objType ?? '').toLowerCase() === 'vectorimage' || /\.svg$/i.test(src.split(/[?#]/)[0]);
    pieces.push({ ...base, kind: vector ? 'vector' : 'raster', src, label: name });
  });
  if (skipped > 0) notes.push({ level: 'info', text: `${skipped} hidden or empty ${skipped === 1 ? 'object was' : 'objects were'} left out.` });

  stackPieces(pieces, rawWindows, notes);
  const lockedTexts = pieces.filter(p => p.kind === 'text' && p.locked).length;
  if (lockedTexts > 0) {
    notes.push({ level: 'info', text: `${lockedTexts} locked ${lockedTexts === 1 ? 'text becomes' : 'texts become'} editable here: a template has no lock.` });
  }
  if (rawWindows.length === 0) blocked.push('The design has no photo window, so there is nothing to make a layout from.');

  const ratio = W / H;
  return {
    productName: String(canvas.name ?? '').trim(),
    printMm: { width: W, height: H },
    canvasPx: { width: Math.round(mmToImportPx(W)), height: Math.round(mmToImportPx(H)) },
    oldCanvasMm: { width: canvasW, height: canvasH, marginLeft, marginTop },
    paperColor: hexColor(design.printableAreaFill),
    windows: readingOrder(rawWindows),
    pieces,
    overlayUrl: typeof canvas.overlay_image_url === 'string' && /^https:\/\//i.test(canvas.overlay_image_url) ? canvas.overlay_image_url : null,
    facing: ratio > 1.02 ? 'landscape' : ratio < 0.98 ? 'portrait' : 'square',
    notes,
    blocked,
  };
}

/**
 * Which layer each piece lands on and which windows it gets a hole for.
 * Every picture belongs to the page artwork; a window listed after a picture
 * it overlaps was above it, so the picture is cut away there.
 */
function stackPieces(pieces: ImportedPiece[], windows: readonly ImportedWindow[], notes: ImportNote[]): void {
  for (const p of pieces) {
    if (p.kind === 'text') {
      p.layer = 'overlay';
      p.holes = [];
      if (pieces.some(q => q.kind !== 'text' && q.index > p.index && overlaps(q.visible, p.visible))) {
        notes.push({ level: 'warning', text: `${p.label} sat under artwork in the old design; here it sits above it.` });
      }
      continue;
    }
    p.layer = 'artwork';
    p.holes = windows.filter(w => w.index > p.index && overlaps(p.visible, w.box)).map(w => w.index);
  }
}

/** What the saved layout holds that the artwork is cut to. */
export interface LayoutGeometry {
  canvas: { widthMm: number; heightMm: number };
  /** In the layout's own order, as fractions of the canvas. */
  frames: ReadonlyArray<{ x: number; y: number; width: number; height: number }>;
}

/**
 * The design re-cut to a layout as the ops user saved it: its canvas and its
 * print areas replace the ones read from the export, and every hole and crop
 * is worked out again. Print areas are matched to the old windows in order
 * (the import writes them in reading order), so each keeps its place in the
 * old stacking; one added in the layout editor has no old place and is cut
 * out of every picture it touches. Pieces keep their distance from the
 * canvas's top-left corner.
 */
export function withLayoutGeometry(design: ImportedDesign, layout: LayoutGeometry): ImportedDesign {
  const W = round(layout.canvas.widthMm, 4);
  const H = round(layout.canvas.heightMm, 4);
  if (!(W > 0 && H > 0)) return design;
  const windows: ImportedWindow[] = layout.frames.map((f, i) => ({
    index: design.windows[i]?.index ?? 1_000_000 + i,
    box: clip({ x: round(f.x * W, 4), y: round(f.y * H, 4), w: round(f.width * W, 4), h: round(f.height * H, 4) }, W, H),
  })).filter(w => w.box.w > 0 && w.box.h > 0);
  const pieces = design.pieces
    .map(p => {
      const visible = clip(p.box, W, H);
      return { ...p, visible, overflows: differs(visible, p.box), holes: [] as number[] };
    })
    .filter(p => p.visible.w > 0 && p.visible.h > 0);
  const stale = /sat under artwork in the old design/;
  const notes = design.notes.filter(note => !stale.test(note.text));
  stackPieces(pieces, windows, notes);
  const blocked = design.blocked.filter(b => !/no photo window/.test(b));
  if (windows.length === 0) blocked.push('The layout has no print area, so there is nothing to cut the artwork to.');
  const ratio = W / H;
  return {
    ...design,
    printMm: { width: W, height: H },
    canvasPx: { width: Math.round(mmToImportPx(W)), height: Math.round(mmToImportPx(H)) },
    windows,
    pieces,
    facing: ratio > 1.02 ? 'landscape' : ratio < 0.98 ? 'portrait' : 'square',
    notes,
    blocked,
  };
}

/** The design with no photo windows: its page artwork is then every picture
 *  whole, which is what the layout editor shows behind the print areas. */
export const withoutWindows = (design: ImportedDesign): ImportedDesign =>
  ({ ...design, windows: [], pieces: design.pieces.map(p => ({ ...p, holes: [] })) });

// ─── The layout ──────────────────────────────────────────────────────────────

/** The layout as the ops layout editor would save it: the print area as the
 *  canvas, one print area per window in reading order, the whole canvas printed. */
export interface ImportedLayoutDefinition {
  name: string;
  canvas: { width: number; height: number; widthMm: number; heightMm: number; dpi: number };
  frames: Array<{ id: string; x: number; y: number; width: number; height: number; xMm: number; yMm: number; widthMm: number; heightMm: number; bleedMm: number; borderRadiusMm: number }>;
  frameMaskUrl: null;
  artworkMaskUrl: null;
  printSheet: { mode: 'canvas' };
  frameCaptionsEnabled: boolean;
  orientationRotatable: boolean;
}

export function layoutDefinitionFor(design: ImportedDesign, name: string): ImportedLayoutDefinition {
  const W = round(design.printMm.width, 2);
  const H = round(design.printMm.height, 2);
  const frames = design.windows.map((w, i) => {
    const xMm = round(w.box.x, 2), yMm = round(w.box.y, 2);
    const widthMm = round(Math.min(w.box.w, W - xMm), 2), heightMm = round(Math.min(w.box.h, H - yMm), 2);
    return {
      id: `import-${i + 1}`,
      x: xMm / W, y: yMm / H, width: widthMm / W, height: heightMm / H,
      xMm, yMm, widthMm, heightMm, bleedMm: 0, borderRadiusMm: 0,
    };
  });
  return {
    name,
    canvas: { width: design.canvasPx.width, height: design.canvasPx.height, widthMm: W, heightMm: H, dpi: IMPORT_DPI },
    frames,
    frameMaskUrl: null,
    artworkMaskUrl: null,
    printSheet: { mode: 'canvas' },
    frameCaptionsEnabled: false,
    orientationRotatable: true,
  };
}

/** A layout identifier and a display name from the old product's name:
 *  "Photo Frame | 6 x 8 in" with 3 windows → photo_frame_6x8_3_photos. */
export function suggestNames(design: ImportedDesign): { name: string; displayName: string } {
  const count = design.windows.length;
  const photos = `${count} ${count === 1 ? 'photo' : 'photos'}`;
  const product = design.productName.split('|')[0].trim() || 'Imported design';
  const size = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i.exec(design.productName);
  const sizeWords = size ? `${size[1]}x${size[2]}` : `${round(design.printMm.width / MM_PER_INCH, 1)}x${round(design.printMm.height / MM_PER_INCH, 1)}`;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return {
    name: [slug(product), slug(sizeWords), slug(photos)].filter(Boolean).join('_').slice(0, 60),
    displayName: `${product} ${sizeWords.replace('x', ' x ')} in, ${photos}`,
  };
}

// ─── Artwork ─────────────────────────────────────────────────────────────────

/** An artwork file as fetched: SVG markup, or the bytes of a PNG or JPEG. */
export type ArtworkSource =
  | { kind: 'svg'; text: string }
  | { kind: 'png' | 'jpeg'; bytes: Uint8Array };

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
      + (b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)])
      + (c === undefined ? '=' : B64[c & 63]);
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let n = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]), b = B64.indexOf(clean[i + 1]);
    const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : -1;
    const d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : -1;
    out[n++] = (a << 2) | (b >> 4);
    if (c >= 0) out[n++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) out[n++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, n);
}

/** What a file is, from its first bytes; null for anything this import cannot place. */
export function sniffArtwork(bytes: Uint8Array): 'png' | 'jpeg' | 'svg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<svg') || ((head.startsWith('<?xml') || head.startsWith('<!')) && head.includes('<svg'))) return 'svg';
  return null;
}

/** Pixel size of a PNG or JPEG, read from its header; null when unreadable. */
export function rasterSize(bytes: Uint8Array): { width: number; height: number } | null {
  const kind = sniffArtwork(bytes);
  const be = (i: number, n: number) => { let v = 0; for (let k = 0; k < n; k += 1) v = v * 256 + bytes[i + k]; return v; };
  if (kind === 'png' && bytes.length >= 24) return { width: be(16, 4), height: be(20, 4) };
  if (kind !== 'jpeg') return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    // Start-of-frame markers carry the size; C4, C8 and CC are tables, not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: be(i + 7, 2), height: be(i + 5, 2) };
    }
    i += 2 + be(i + 2, 2);
  }
  return null;
}

/** Dots per inch a raster of this pixel width has when placed this wide. */
export const placedDpi = (pixelWidth: number, placedWidthMm: number): number =>
  (placedWidthMm > 0 ? Math.round(pixelWidth / (placedWidthMm / MM_PER_INCH)) : 0);

export interface SvgParts {
  viewBox: [number, number, number, number];
  /** The root element's own attributes, as written, minus its geometry. */
  attrs: Array<[string, string]>;
  /** Extra namespaces the root declared (`xlink`, …), for the wrapper to declare. */
  namespaces: Array<[string, string]>;
  inner: string;
}

const ROOT_DROP = new Set(['x', 'y', 'width', 'height', 'viewbox', 'preserveaspectratio', 'version', 'baseprofile', 'id', 'xmlns']);

const lengthPx = (v: string | undefined): number => {
  const m = /^\s*([0-9.]+)\s*(px)?\s*$/i.exec(v ?? '');
  return m ? Number(m[1]) : NaN;
};

/** The pieces of an SVG file needed to place it inside another: its
 *  viewBox, its root attributes and everything between the root's tags.
 *  The prolog, any DOCTYPE and comments are left behind. Null when the
 *  markup has no usable root or no size. */
export function readSvg(markup: string): SvgParts | null {
  const text = markup.replace(/<!--[\s\S]*?-->/g, '');
  const open = /<svg\b([^>]*)>/i.exec(text);
  if (!open) return null;
  const selfClosing = /\/\s*$/.test(open[1]);
  const close = text.toLowerCase().lastIndexOf('</svg');
  if (!selfClosing && close < open.index) return null;
  const all: Array<[string, string]> = [];
  const re = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(open[1])) !== null) all.push([m[1], m[2] ?? m[3] ?? '']);
  const get = (name: string) => all.find(([k]) => k.toLowerCase() === name)?.[1];
  const box = (get('viewbox') ?? '').trim().split(/[\s,]+/).map(Number);
  let viewBox: [number, number, number, number] | null = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0
    ? [box[0], box[1], box[2], box[3]] : null;
  if (!viewBox) {
    const w = lengthPx(get('width')), h = lengthPx(get('height'));
    if (w > 0 && h > 0) viewBox = [0, 0, w, h];
  }
  if (!viewBox) return null;
  return {
    viewBox,
    attrs: all.filter(([k]) => !ROOT_DROP.has(k.toLowerCase()) && !k.toLowerCase().startsWith('xmlns:')),
    namespaces: all.filter(([k]) => k.toLowerCase().startsWith('xmlns:')),
    inner: selfClosing ? '' : text.slice(open.index + open[0].length, close),
  };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Give every id and class in a piece of SVG markup a prefix, so two files
 * exported by the same drawing program (both full of `.cls-1` and
 * `#clip-path`) can live in one document without restyling each other.
 */
export function scopeSvg(markup: string, prefix: string): string {
  const ids = new Set<string>();
  const classes = new Set<string>();
  for (const m of markup.matchAll(/\bid\s*=\s*(["'])([^"']+)\1/g)) ids.add(m[2]);
  for (const m of markup.matchAll(/\bclass\s*=\s*(["'])([^"']+)\1/g)) m[2].trim().split(/\s+/).forEach(c => classes.add(c));
  const styled = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (const m of markup.matchAll(styled)) for (const c of m[1].matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) classes.add(c[1]);
  if (ids.size === 0 && classes.size === 0) return markup;

  let out = markup.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, block => {
    let css = block;
    for (const c of classes) css = css.replace(new RegExp(`\\.${escapeRe(c)}(?![\\w-])`, 'g'), `.${prefix}-${c}`);
    for (const id of ids) css = css.replace(new RegExp(`#${escapeRe(id)}(?![\\w-])(?=[^;{}]*\\{)`, 'g'), `#${prefix}-${id}`);
    return css;
  });
  out = out.replace(/\bid\s*=\s*(["'])([^"']+)\1/g, (_all, q: string, id: string) => `id=${q}${prefix}-${id}${q}`);
  out = out.replace(/\bclass\s*=\s*(["'])([^"']+)\1/g, (_all, q: string, list: string) =>
    `class=${q}${list.trim().split(/\s+/).map(c => `${prefix}-${c}`).join(' ')}${q}`);
  out = out.replace(/url\(\s*(["']?)#([^"')\s]+)\1\s*\)/g, (all, q: string, id: string) => (ids.has(id) ? `url(${q}#${prefix}-${id}${q})` : all));
  out = out.replace(/\bhref\s*=\s*(["'])#([^"']+)\1/g, (all, q: string, id: string) => (ids.has(id) ? `href=${q}#${prefix}-${id}${q}` : all));
  return out;
}

const n = (v: number): string => String(round(v, 3));

interface PxBox { x: number; y: number; w: number; h: number }
const toPx = (b: MmBox): PxBox => ({ x: mmToImportPx(b.x), y: mmToImportPx(b.y), w: mmToImportPx(b.w), h: mmToImportPx(b.h) });

/** One artwork placed at `box` (print px) as SVG markup, with the
 *  namespaces it needs declared on the document root. */
function placed(source: ArtworkSource, box: PxBox, scope: string | null): { markup: string; namespaces: Array<[string, string]> } | null {
  if (source.kind !== 'svg') {
    const href = `data:image/${source.kind};base64,${bytesToBase64(source.bytes)}`;
    return { markup: `<image x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" preserveAspectRatio="none" href="${href}"/>`, namespaces: [] };
  }
  const parts = readSvg(source.text);
  if (!parts) return null;
  const attrs = parts.attrs.map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`).join('');
  const markup = `<svg x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" viewBox="${parts.viewBox.map(n).join(' ')}" preserveAspectRatio="none"${attrs}>${parts.inner}</svg>`;
  return { markup: scope ? scopeSvg(markup, scope) : markup, namespaces: parts.namespaces };
}

function svgDocument(view: PxBox, defs: string, body: string, namespaces: Array<[string, string]>): string {
  const seen = new Map<string, string>();
  for (const [k, v] of namespaces) if (!seen.has(k)) seen.set(k, v);
  const ns = [...seen].map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg"${ns} viewBox="${n(view.x)} ${n(view.y)} ${n(view.w)} ${n(view.h)}" width="${n(view.w)}" height="${n(view.h)}">`
    + `${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;
}

const sourceOf = (piece: ImportedPiece, sources: ReadonlyMap<number, ArtworkSource>): ArtworkSource | null =>
  (piece.kind === 'shape' && piece.inlineSvg ? { kind: 'svg', text: piece.inlineSvg } : sources.get(piece.index) ?? null);

export interface BuiltArtwork {
  /** The SVG document, in print pixels of the canvas; null when no piece belongs to it. */
  svg: string | null;
  /** Pieces left out because their file could not be read. */
  missing: ImportedPiece[];
}

/**
 * The page artwork: every picture, stacked in the old order on one sheet
 * the size of the canvas, each with a hole for the windows that were above
 * it and cropped to the sheet. One document so it can carry the
 * editor's `Artwork` behaviour (a click on a hole reaches the photo).
 */
export function buildPageArtwork(design: ImportedDesign, sources: ReadonlyMap<number, ArtworkSource>): BuiltArtwork {
  const under = design.pieces.filter(p => p.layer === 'artwork');
  if (under.length === 0) return { svg: null, missing: [] };
  const page: PxBox = { x: 0, y: 0, w: design.canvasPx.width, h: design.canvasPx.height };
  const windowBox = new Map(design.windows.map(w => [w.index, w.box]));
  const vectors = under.filter(p => sourceOf(p, sources)?.kind === 'svg').length;
  const missing: ImportedPiece[] = [];
  const namespaces: Array<[string, string]> = [];
  let defs = '';
  let body = '';
  for (const piece of under) {
    const source = sourceOf(piece, sources);
    const art = source ? placed(source, toPx(piece.box), vectors > 1 ? `p${piece.index}` : null) : null;
    if (!art) { missing.push(piece); continue; }
    namespaces.push(...art.namespaces);
    let group = '';
    if (piece.holes.length > 0) {
      const id = `pe-holes-${piece.index}`;
      let d = `M0 0H${n(page.w)}V${n(page.h)}H0Z`;
      for (const index of piece.holes) {
        const b = windowBox.get(index);
        if (!b) continue;
        const hole = toPx({ x: b.x + HOLE_INSET_MM, y: b.y + HOLE_INSET_MM, w: b.w - 2 * HOLE_INSET_MM, h: b.h - 2 * HOLE_INSET_MM });
        if (hole.w > 0 && hole.h > 0) d += `M${n(hole.x)} ${n(hole.y)}h${n(hole.w)}v${n(hole.h)}h${n(-hole.w)}Z`;
      }
      defs += `<clipPath id="${id}"><path clip-rule="evenodd" d="${d}"/></clipPath>`;
      group += ` clip-path="url(#${id})"`;
    }
    if (piece.opacity < 1) group += ` opacity="${n(piece.opacity)}"`;
    body += `<g${group}>${art.markup}</g>`;
  }
  // The root crops what runs off the sheet: an outer <svg> clips to its viewport.
  return { svg: body ? svgDocument(page, defs, body, namespaces) : null, missing };
}

export interface TextOverlaySpec {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  color: string;
  fontFamily: string;
  textAlign: 'left' | 'center' | 'right';
  rotation: number;
}

/** A text as a text overlay holds it: (x, y) is the box's left edge, centre
 *  or right edge by alignment and its vertical middle, in percent of the
 *  canvas (lib/overlay-text.ts); the size is in print pixels. */
export function textOverlayFor(design: ImportedDesign, piece: ImportedPiece): TextOverlaySpec | null {
  const t = piece.text;
  if (!t) return null;
  const { width: W, height: H } = design.printMm;
  const anchor = t.align === 'center' ? piece.box.x + piece.box.w / 2 : t.align === 'right' ? piece.box.x + piece.box.w : piece.box.x;
  const clamp = (v: number) => Math.min(100, Math.max(0, round(v, 3)));
  return {
    text: t.text,
    x: clamp((anchor / W) * 100),
    y: clamp(((piece.box.y + piece.box.h / 2) / H) * 100),
    width: clamp((piece.box.w / W) * 100),
    fontSize: t.fontSizePx,
    color: t.color,
    fontFamily: t.fontFamily,
    textAlign: t.align,
    rotation: 0,
  };
}

/**
 * The old tool's frame overlay as it lies over our canvas: the overlay is
 * drawn over the whole old canvas, of which the print area is the middle,
 * so the document shows just that middle. For the layout's frame picture
 * (preview only, never printed). Null when the file cannot be read.
 */
export function frameOverlaySvg(design: ImportedDesign, source: ArtworkSource): string | null {
  const { width, height, marginLeft, marginTop } = design.oldCanvasMm;
  const art = placed(source, toPx({ x: -marginLeft, y: -marginTop, w: width, h: height }), null);
  if (!art) return null;
  return svgDocument({ x: 0, y: 0, w: design.canvasPx.width, h: design.canvasPx.height }, '', art.markup, art.namespaces);
}

/** Fonts the design's texts use, once each, as written. */
export function fontsUsed(design: ImportedDesign): string[] {
  const seen = new Map<string, string>();
  for (const p of design.pieces) {
    const family = p.text?.fontFamily;
    if (family && !seen.has(family.toLowerCase())) seen.set(family.toLowerCase(), family);
  }
  return [...seen.values()];
}
