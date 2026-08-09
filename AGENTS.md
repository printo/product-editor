# Project Customization & Workflow Rules

## Git & Pull Request Workflow

All code modifications must strictly follow this process:

1. **Pull Main First:**
   Before starting any task, switch to `main` and pull latest changes:
   ```bash
   git checkout main && git pull origin main
   ```

2. **Branch Creation:**
   Create a dedicated feature or fix branch from `main`:
   ```bash
   git checkout -b <feat|fix>/<short-description>
   ```
   Never commit or edit files directly on `main`.

3. **Commit & Push to Feature Branch:**
   After completing changes and verification, stage and commit files, then push the feature branch to `origin`:
   ```bash
   git push -u origin <branch-name>
   ```

4. **Raise PR Only (No Direct Merge to Main):**
   Do **NOT** merge into `main` directly. Provide the GitHub Pull Request link to the user to review and merge.
