# Storage Migration Deployment Runbook

## Overview
This document describes the deployment procedure for the storage migration from filesystem layouts to Postgres LayoutCatalogue and S3 asset storage.

**Status**: Phases 1-5 complete. Phase 6 (testing) in progress.

---

## Pre-Deployment (Production Server)

### Step 1: Export Production Layout Catalogue
**When**: Before deploying migration 0016

On the production server:
```bash
cd /home/ubuntu/product-editor

# Export all live layouts to JSON
python backend/scripts/export_layout_catalogue.py \
  /home/ubuntu/product-editor/storage/layouts \
  /tmp/prod_layouts.json

# Verify count matches filesystem
echo "Filesystem layout count:"
find /home/ubuntu/product-editor/storage/layouts -name "*.json" | wc -l

echo "Export count:"
cat /tmp/prod_layouts.json | jq 'length'
```

**Expected**: Both counts match (e.g., 47 layouts)

### Step 2: Commit Layout Dump
On your local machine:
```bash
# Copy the dump from prod
scp ubuntu@product-editor.printo.in:/tmp/prod_layouts.json backend/migrations/

# Verify it's valid JSON
python -m json.tool backend/migrations/prod_layouts.json > /dev/null

# Commit
git add backend/migrations/prod_layouts.json
git commit -m "chore: bake prod layout catalogue for migration 0016"
git push
```

### Step 3: Configure S3 Credentials (Optional - only for S3)
If deploying S3 storage, set environment variables in prod `.env`:
```bash
STORAGE_BACKEND=s3
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
AWS_REGION=ap-south-1
S3_BUCKET=product-editor-prod
```

For now, keep `STORAGE_BACKEND=local` to minimize risk.

---

## Deployment

### Step 1: Push to Main
```bash
git push origin main
```

### Step 2: Run Deploy Script
On the production server:
```bash
cd /home/ubuntu/product-editor
./deploy.sh both
```

The script will:
- Pull `main` (includes migration 0016)
- Rebuild backend image (includes LayoutCatalogue model)
- Run `manage.py migrate` (applies migration 0016)
- Migration 0016 imports layouts from `backend/migrations/prod_layouts.json`

**Expected**: Migration succeeds, logs show "Imported N layouts"

### Step 3: Verify Migration Completed
```bash
docker-compose exec backend python manage.py showmigrations api | grep 0016

# Should show: [X] 0016_import_layout_catalogue
```

---

## Post-Deployment Verification

### Step 1: Verify Layout Count
```bash
docker-compose exec backend python manage.py shell << 'EOF'
from api.models import LayoutCatalogue

db_count = LayoutCatalogue.objects.filter(is_deprecated=False).count()
print(f"Layouts in DB: {db_count}")

# Check a specific layout
try:
    layout = LayoutCatalogue.objects.get(name='circle_48mm')
    print(f"Found 'circle_48mm': version={layout.version}, product_type={layout.product_type}")
except LayoutCatalogue.DoesNotExist:
    print("WARNING: 'circle_48mm' not imported!")
EOF
```

**Expected**: Count matches prod export, sample layouts exist

### Step 2: Check Cache Invalidation Logic
```bash
curl -s https://product-editor.printo.in/api/layouts | jq '.layouts | length'
# Should return layout list from LayoutCatalogue

curl -s https://product-editor.printo.in/api/layouts/circle_48mm | jq '.name'
# Should return: "circle_48mm"
```

### Step 3: Test Ops Management
```bash
# Login as ops (via API key or PIA session)
curl -s -H "Authorization: Bearer $DIRECT_API_KEY" \
  https://product-editor.printo.in/api/ops/layouts | jq '.layouts | length'

# Should include all layouts (public + private + deprecated)
```

### Step 4: Test Embed Flow
```bash
# Create an embed session
curl -s -X POST https://product-editor.printo.in/api/embed/session \
  -H "Authorization: Bearer $DIRECT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"order_id":"TEST-1"}' | jq '.token'

# Open editor with token
# Should render layout picker correctly
```

### Step 5: Run Smoke Tests
```bash
cd /home/ubuntu/product-editor

# Embed flow smoke test
API_KEY=$DIRECT_API_KEY BASE=https://localhost \
  ./scripts/smoke-test-embed.sh

# Calendar smoke test
API_KEY=$DIRECT_API_KEY BASE=https://localhost \
  ./scripts/smoke-test-calendar.sh
```

**Expected**: Both tests pass (19+ checks each)

---

## Rollback Plan

If migration fails or causes issues:

### Option 1: Revert to Filesystem (Keep DB)
1. Set `STORAGE_BACKEND=local` in `.env`
2. Keep layouts on disk at `storage/layouts/`
3. Run `docker-compose up -d`
4. Views will still query LayoutCatalogue, but fallback to filesystem not implemented

**Note**: This is a partial rollback. Full rollback requires restoring from backup.

### Option 2: Full Rollback
1. `git revert <commit with migration>`
2. Push to main
3. Run `./deploy.sh both` (runsmigration reverse)
4. Restore `storage/layouts/` from backup if needed

---

## Monitoring

After deployment, watch for:

### Error Logs
```bash
docker-compose logs -f backend | grep -i "layout\|migrate"
```

### Database Queries
Monitor slow queries on LayoutCatalogue:
```bash
# In Django shell
from django.db import connection
from django.db import reset_queries
reset_queries()

LayoutCatalogue.objects.filter(is_deprecated=False).count()

from django.db import connection
for q in connection.queries:
    print(q['time'], q['sql'][:100])
```

### Cache Performance
```bash
# Check cache hit rate
docker-compose exec backend redis-cli INFO stats
```

---

## Known Limitations (Phase 6)

- Masks still stored on disk (local) or S3 (pending Phase 4 testing)
- Calendar assets read via new asset_store module (Phase 5)
- Direct partner API (`GenerateLayoutView`) still reads layouts from disk; Phase 3b refactor pending
- S3 storage not yet tested in production; recommend running `STORAGE_BACKEND=local` initially

---

## Success Criteria

✅ All criteria must pass before production deployment:

1. **Layouts imported**: DB count = filesystem count
2. **Queries work**: ListLayoutsView, GetLayoutView, EditorInitView return correct data
3. **Cache invalidation works**: Layout edits immediately visible, no stale data
4. **Ops flows work**: PUT/DELETE on /api/ops/layouts work correctly
5. **Embed flows work**: Embed proxy resolves layouts, render jobs complete
6. **Smoke tests pass**: All 19+ embed checks + 19+ calendar checks pass
7. **No regressions**: Customer-facing flows unchanged, print output identical

---

## Timeline

- **Pre-deploy**: 30 min (export + commit)
- **Deploy**: 10 min (docker-compose)
- **Verification**: 20 min (manual checks + smoke tests)
- **Total**: ~1 hour

Recommend deploying during low-traffic hours (early morning, no major customer rendering).
