# Git Branching & Pull Request Workflow

Always enforce the following Git workflow for all code modifications:

1. **Pull Latest Main:**
   Before making any file or code changes, always check out `main` and pull the latest changes:
   ```bash
   git checkout main && git pull origin main
   ```

2. **Create a Dedicated Branch:**
   Always create a descriptive feature/bugfix branch from `main`:
   ```bash
   git checkout -b feat/short-description # or fix/...
   ```
   **NEVER** write code or commit directly on `main`.

3. **Commit & Push Feature Branch:**
   Once work is completed and verified, commit to the feature branch and push it to the remote repository:
   ```bash
   git add <files>
   git commit -m "feat(topic): descriptive message"
   git push -u origin <branch-name>
   ```

4. **Raise PR (No Direct Merge to Main):**
   Raise a Pull Request on GitHub and provide the PR creation link to the user. **DO NOT** execute `git merge` into `main` directly.
