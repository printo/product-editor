# AI Guardrails - Product Editor

**STRICT SAFETY RULES: AI ASSISTANTS MUST NEVER VIOLATE THE FOLLOWING.**

## Critical Prohibitions
- **No Mass Rewrites**: Never rewrite more than 20% of a file in one go without explicit confirmation.
- **No Framework Swapping**: Do not attempt to replace Django or Next.js with other frameworks.
- **No Secret Creation**: Never hardcode API keys, tokens, or credentials.
- **No Volume Deletion**: Never delete or purge `/storage` volumes.

## Architecture Protection
- **Module Boundaries**: Do not move files between `frontend` and `backend`.
- **Path Safety**: Never implement file paths without using `os.path.join` and verifying path safety (preventing traversal).
- **Core Stability**: Do not modify the `Traefik` proxy configuration unless specifically asked to fix a routing bug.

## Dependency Control
- **No Shadow Dependencies**: Do not install packages without updating `package.json` or `requirements.txt`.
- **Strict Versioning**: Use fixed versions for packages if you must add them.

## Safe Coding Rules
- **Dry Run**: Use `find` and `grep` to check for similar code before implementing new logic.
- **Audit Preservation**: Do not disable the `api/middleware.py` logging or rate-limiting layers.
- **Client-Side Heavy Lifting**: Do not move heavy AI processing (e.g., RemBG) to the frontend; use the existing backend API.
- **Zip Standards**: Use `JSZip` exclusively for multi-file exports.

## Decision Policy
- **When in Doubt, Ask**: If an architectural decision is ambiguous, prompt the user for clarification.
- **No Guessing**: Do not "hallucinate" API endpoints or internal utility names; verify them using `grep` or `list_dir`.
