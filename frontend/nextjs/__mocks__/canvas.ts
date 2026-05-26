/**
 * Stub the `canvas` native module so jsdom doesn't crash trying to
 * load `canvas.node` when Jest spins up the dom environment.
 *
 * Fabric.js declares `canvas` as a peer dep; jsdom auto-imports it if
 * present. We don't render to a real canvas in component tests
 * (Fabric runs in the browser, not in jsdom), so an empty shim is fine.
 *
 * If a future test actually needs `OffscreenCanvas` or `canvas-2d`
 * APIs, switch to `@napi-rs/canvas` or a real install. For Phase 5
 * customer-preview component tests, nothing renders pixels.
 */
export default {};
export const Canvas = class {};
export const Image = class {};
export const createCanvas = () => ({});
export const loadImage = async () => ({});
