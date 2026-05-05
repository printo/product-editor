/**
 * Fabric.js module augmentation — typed declarations for the custom
 * properties our editor stamps onto Fabric objects and the canvas.
 *
 * Why: across `FabricEditor.tsx`, `LayoutFabricPreview.tsx`, the editor
 * page and sidebar there were ~80 `(obj as any).__frameIdx`, `(o as any)
 * [DATA_KEY]` etc. casts to bypass TypeScript not knowing about these
 * extension fields. Module augmentation makes them part of Fabric's
 * public type so direct access is type-checked, no `as any` required.
 *
 * Convention: a leading `__` marks "internal to product-editor" — not a
 * Fabric-defined property. All optional because plain Fabric objects
 * don't have them; we set them on objects we author.
 */

import 'fabric'

declare module 'fabric' {
  interface FabricObject {
    /** Index into editingCanvas.frames[] for objects that represent a frame's image / outline / mask. */
    __frameIdx?: number
    /** Stable ID for a frame, copied from FrameState.id. Used for selection persistence across rebuilds. */
    __frameId?: string
    /** Index into editingCanvas.overlays[] for objects representing a text/shape/image overlay. */
    __overlayIdx?: number

    /**
     * Discriminator for objects we authored. Mirrors the string constant
     * `DATA_KEY = '__fabricEditor'` in FabricEditor.tsx and the same key
     * in LayoutFabricPreview.tsx. Lets us identify our objects vs ones
     * added by Fabric/the user.
     *
     * - FabricEditor sets: 'frame' | 'text' | 'shape' | 'image' | 'mask'
     * - LayoutFabricPreview sets: 'frame' | 'guide' | 'grid' | 'bleed' | 'label' | 'mask'
     */
    __fabricEditor?: 'frame' | 'text' | 'shape' | 'image' | 'mask' | 'guide' | 'grid' | 'bleed' | 'label'

    // Layer markers — all booleans, set on objects that act as decoration
    // / scaffolding rather than user content. Used by the rebuild logic
    // to find + manipulate them without colliding with user objects.
    __paper?: boolean         // mirrors PAPER_KEY = '__paper'
    __bgLayer?: boolean
    __bleedLayer?: boolean
    __safeLayer?: boolean
    __outlineLayer?: boolean
    __gridLayer?: boolean
    __guideLayer?: boolean
    __layoutPreview?: boolean

    /** Frame's clip rectangle in canvas-space px. Set by FabricEditor when an image is fitted into a frame; consumed during pan/zoom math. Not the same as Fabric's `clipPath`. */
    __clipRect?: { fx: number; fy: number; fw: number; fh: number }
  }

  interface Canvas {
    /** Set true while the user is space-drag-panning the canvas viewport. */
    __isPanning?: boolean
  }

  interface StaticCanvas {
    __isPanning?: boolean
  }
}
