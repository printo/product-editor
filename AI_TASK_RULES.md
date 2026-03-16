# Task Implementation Rules - Product Editor

This file defines the workflow and coding rules for AI assistants implementing tasks.

## Workflow Rules
1. **Research First**: Always check `AI_FILE_INDEX.md` and `ARCHITECTURE.md` before editing.
2. **Atomic Changes**: Implement features in small, logical increments.
3. **Verify Early**: Run `python manage.py check` (backend) or `next lint` (frontend) after every significant change.
4. **No Duplication**: Reuse existing utilities in `api/storage.py` and `src/lib/` instead of rewriting them.

## Editing Guidelines
- **Minimal Modification**: Always prefer the smallest possible diff that achieves the goal safely.
- **Style Consistency**: Match the existing indentation and naming conventions exactly.
- **Multipart Standard**: All new POST/PUT endpoints must handle `multipart/form-data`.
- **Error Handling**: Use DRF's `Response` with appropriate HTTP status codes.

## Dependency Management
- **Avoid New Libraries**: Exhaust internal solutions before suggesting new `npm` or `pip` packages.
- **Explicit Rationale**: If a new dependency is required, explain why in the implementation plan.

## File Creation Rules
- **Logical Placement**: Place new components in `src/components/` and new logic in the appropriate backend app.
- **Structured State**: New dashboard features must adhere to the `CanvasItem` and `FrameState` definitions for transform persistence.
- **Zip Utilities**: Always use `src/lib/zip-utils.ts` for batch file archiving.
- **Naming**: Use PascalCase for React components and snake_case for Python files.

## Documentation Rules
- **Task List**: Maintain a `task.md` artifact during long tasks.
- **Walkthrough**: Create a `walkthrough.md` artifact summarizing your changes and verification steps.
