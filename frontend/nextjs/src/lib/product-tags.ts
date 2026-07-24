// Product-category tags — one per SKU family (not format/style descriptors).
// Drives the clickable filter chips on both the dashboard and the ops layout
// list, plus the "Primary Tag" dropdown on the create-layout form.
export const AVAILABLE_TAGS = [
  'Photo Prints',   // standard prints: 4×6, 5×7, polaroid, square, instant
  'Canvas Prints',  // stretched canvas, gallery wraps
  'Magnets',        // fridge magnets (48 mm circle, rect)
  'Coasters',       // photo coasters
  'Mugs',           // photo mugs
  'Stationery',     // business cards, postcards, passport prints, stamps
  'Gifts',          // laptop sleeves, custom gifts
  'Calendar',       // productType=calendar layouts
  'Photobook',      // productType=photobook (future)
];
