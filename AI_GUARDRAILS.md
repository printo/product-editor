# AI Guardrails - Product Editor

Development rules and safety guidelines for AI agents working on this project.

## General Rules
- **No AI Processing**: Do not re-introduce background removal, product detection, or other AI-based image processing features unless explicitly requested.
- **Maintain multi-surface support**: Ensure changes do not break the ability to handle layouts with multiple surfaces (e.g., front/back).
- **TypeScript Strictness**: Always fix linter errors and maintain type safety in the frontend.

## Backend Guardrails (Django)
- **Path Safety**: Always use `_is_path_safe` or similar validation when handling file paths from requests to prevent path traversal.
- **Authentication**: All new endpoints must require appropriate permissions (e.g., `IsAuthenticatedWithAPIKey`).
- **Resource Management**: Large image processing tasks should be handled carefully to avoid memory exhaustion (Pillow uses significant RAM).

## Frontend Guardrails (Next.js/Fabric.js)
- **Object Cleanup**: Always dispose of Fabric canvas instances and revoke Object URLs to prevent memory leaks.
- **State Sync**: Keep the Fabric canvas state in sync with the React state (see `handleFabricChange` in `CanvasEditorModal.tsx`).
- **Responsive Design**: Ensure the editor remains functional on various screen sizes, using the Gen-Z "glassmorphism" aesthetic established in the project.

## Data Consistency
- Layout JSON files in `storage/layouts` must follow the established schema (canvas dimensions, frame coordinates, etc.).
- Ensure `metadata` in layouts remains an object or array as expected by the management views.
