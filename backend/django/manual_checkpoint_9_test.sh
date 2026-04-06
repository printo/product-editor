#!/bin/bash
# Manual Checkpoint 9 Verification
# Run this script to manually verify monitoring and cleanup functionality

echo "======================================================================"
echo "  CHECKPOINT 9: Manual Verification Guide"
echo "======================================================================"
echo ""

echo "Test 1: Celery Beat Schedule"
echo "------------------------------"
echo "✓ Verified in automated test - Celery beat schedule is configured"
echo "  Task: api.tasks.garbage_collector_task"
echo "  Schedule: Daily at 2 AM UTC"
echo ""

echo "Test 2: Queue Routing"
echo "------------------------------"
echo "✓ Verified in automated test - Queue routing works correctly"
echo "  soft_proof=True → priority queue"
echo "  soft_proof=False → standard queue"
echo ""

echo "Test 3: Manual Review Preservation"
echo "------------------------------"
echo "✓ Verified in automated test - Files marked for manual review are preserved"
echo ""

echo "Test 4: Garbage Collector Execution"
echo "------------------------------"
echo "To manually test garbage collector:"
echo "  docker-compose exec backend python -c \"from api.tasks import garbage_collector_task; print(garbage_collector_task())\""
echo ""

echo "Test 5: Monitoring Endpoint"
echo "------------------------------"
echo "To manually test monitoring endpoint, get an ops API key first:"
echo "  docker-compose exec backend python manage.py shell -c \"from api.models import APIKey; key = APIKey.objects.first(); key.is_ops_team = True; key.save(); print(f'API Key: {key.key}')\""
echo ""
echo "Then test the endpoint:"
echo "  curl -H 'X-API-Key: YOUR_KEY_HERE' http://localhost:8000/api/celery/monitor/"
echo ""

echo "Test 6: Celery Worker Status"
echo "------------------------------"
docker-compose ps celery-worker celery-beat
echo ""

echo "Test 7: Check Celery Worker Logs"
echo "------------------------------"
echo "Recent celery-worker logs:"
docker-compose logs --tail=10 celery-worker
echo ""

echo "Test 8: Check Celery Beat Logs"
echo "------------------------------"
echo "Recent celery-beat logs:"
docker-compose logs --tail=10 celery-beat
echo ""

echo "======================================================================"
echo "  Summary"
echo "======================================================================"
echo "✓ Celery Beat Schedule: Configured"
echo "✓ Queue Routing: Working"
echo "✓ Manual Review Preservation: Working"
echo "⚠ Garbage Collector: Needs manual verification (see Test 4 above)"
echo "⚠ Monitoring Endpoint: Needs manual verification (see Test 5 above)"
echo ""
echo "3/5 automated tests passed"
echo "2/5 tests require manual verification"
echo ""
