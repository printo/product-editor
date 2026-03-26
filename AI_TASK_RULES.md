# AI Task Rules - Product Editor

Guidelines for approaching common engineering tasks in this project.

## Adding a New Layout Property
1. Update `types.ts` in the frontend.
2. Update the `renderCanvas` logic in `fabric-renderer.ts`.
3. Update the server-side `LayoutEngine` in `engine.py` to support the new property during high-res export.
4. Ensure the layout management view in `views.py` persists the new property correctly.

## Modifying UI Components
1. Maintain the "glassmorphism" style.
2. Use `lucide-react` for icons.
3. Use `clsx` or `tailwind-merge` for conditional styling.
4. Test interactions (drag-and-drop, zoom, rotation) to ensure they feel fluid.

## Debugging Rendering Issues
1. Check DPI settings in the layout JSON.
2. Verify coordinate systems (Fabric.js uses pixels, while layouts often specify mm).
3. Inspect `fabric-renderer.ts` for off-screen rendering bugs.
4. Verify Pillow's `Resampling.LANCZOS` is used for high-quality scaling on the server.

## Security Updates
1. Prioritize path traversal protection in any file-handling logic.
2. Ensure API keys are never exposed in the URL (use the `EmbedSession` token system).
3. Validate all user-provided data (dimensions, colors, text) before processing.
