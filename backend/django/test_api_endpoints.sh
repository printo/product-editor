#!/bin/bash

# API Endpoint Verification Script
# Tests async generate, status, and monitoring endpoints

set -e

API_KEY="editor_test_sk_m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6g7h8i9j0k1l2"
OPS_API_KEY="editor_dev_sk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6"
BASE_URL="http://localhost:8000"

echo "=========================================="
echo "API Endpoint Verification Tests"
echo "=========================================="
echo ""

# Test 1: Async Generate Endpoint
echo "Test 1: Async Generate Endpoint (with callback_url)"
echo "-------------------------------------------"
RESPONSE=$(curl -s -X POST "${BASE_URL}/api/generate" \
  -H "X-API-Key: ${API_KEY}" \
  -F "layout=classic_4x6" \
  -F "images=@/app/storage/uploads/test_red.png" \
  -F "fit_mode=cover" \
  -F "export_format=png" \
  -F "soft_proof=false" \
  -F "order_id=test_order_$(date +%s)" \
  -F "callback_url=http://example.com/callback")

echo "Response: ${RESPONSE}"
echo ""

# Extract job_id and status_url
JOB_ID=$(echo "${RESPONSE}" | grep -o '"job_id":"[^"]*"' | cut -d'"' -f4)
STATUS_URL=$(echo "${RESPONSE}" | grep -o '"status_url":"[^"]*"' | cut -d'"' -f4)

if [ -z "${JOB_ID}" ]; then
  echo "❌ FAILED: No job_id returned"
  exit 1
else
  echo "✅ PASSED: job_id returned: ${JOB_ID}"
fi

if [ -z "${STATUS_URL}" ]; then
  echo "❌ FAILED: No status_url returned"
  exit 1
else
  echo "✅ PASSED: status_url returned: ${STATUS_URL}"
fi

# Check for 202 status (we'll verify this separately)
echo ""

# Test 2: Job Status Endpoint
echo "Test 2: Job Status Endpoint"
echo "-------------------------------------------"
sleep 2  # Give the job a moment to start processing

STATUS_RESPONSE=$(curl -s -X GET "${BASE_URL}${STATUS_URL}" \
  -H "X-API-Key: ${API_KEY}")

echo "Status Response: ${STATUS_RESPONSE}"
echo ""

# Verify status response contains expected fields
if echo "${STATUS_RESPONSE}" | grep -q '"job_id"'; then
  echo "✅ PASSED: Status response contains job_id"
else
  echo "❌ FAILED: Status response missing job_id"
fi

if echo "${STATUS_RESPONSE}" | grep -q '"status"'; then
  echo "✅ PASSED: Status response contains status field"
else
  echo "❌ FAILED: Status response missing status field"
fi

echo ""

# Test 3: Wait for job completion and verify output
echo "Test 3: Wait for Job Completion"
echo "-------------------------------------------"
MAX_WAIT=30
ELAPSED=0
while [ ${ELAPSED} -lt ${MAX_WAIT} ]; do
  STATUS_CHECK=$(curl -s -X GET "${BASE_URL}${STATUS_URL}" \
    -H "X-API-Key: ${API_KEY}")
  
  CURRENT_STATUS=$(echo "${STATUS_CHECK}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  echo "Current status: ${CURRENT_STATUS} (${ELAPSED}s elapsed)"
  
  if [ "${CURRENT_STATUS}" = "completed" ]; then
    echo "✅ PASSED: Job completed successfully"
    echo "Final response: ${STATUS_CHECK}"
    
    # Verify output_files field exists
    if echo "${STATUS_CHECK}" | grep -q '"output_files"'; then
      echo "✅ PASSED: Output files field present"
    else
      echo "❌ FAILED: Output files field missing"
    fi
    break
  elif [ "${CURRENT_STATUS}" = "failed" ]; then
    echo "❌ FAILED: Job failed"
    echo "Error response: ${STATUS_CHECK}"
    exit 1
  fi
  
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [ ${ELAPSED} -ge ${MAX_WAIT} ]; then
  echo "⚠️  WARNING: Job did not complete within ${MAX_WAIT} seconds"
fi

echo ""

# Test 4: Monitoring Endpoint (Ops Team)
echo "Test 4: Monitoring Endpoint (Ops Team)"
echo "-------------------------------------------"
MONITOR_RESPONSE=$(curl -s -X GET "${BASE_URL}/api/celery/monitor/" \
  -H "X-API-Key: ${OPS_API_KEY}")

echo "Monitoring Response: ${MONITOR_RESPONSE}"
echo ""

if echo "${MONITOR_RESPONSE}" | grep -q '"workers"'; then
  echo "✅ PASSED: Monitoring response contains workers info"
else
  echo "❌ FAILED: Monitoring response missing workers info"
fi

if echo "${MONITOR_RESPONSE}" | grep -q '"queues"'; then
  echo "✅ PASSED: Monitoring response contains queues info"
else
  echo "❌ FAILED: Monitoring response missing queues info"
fi

echo ""

# Test 5: Backward Compatibility - Sync Mode
echo "Test 5: Backward Compatibility - Sync Mode (no callback_url)"
echo "-------------------------------------------"
echo "Testing synchronous mode (this may take a few seconds)..."

SYNC_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/generate" \
  -H "X-API-Key: ${API_KEY}" \
  -F "layout=classic_4x6" \
  -F "images=@/app/storage/uploads/test_blue.png" \
  -F "fit_mode=cover" \
  -F "export_format=png")

echo "Sync Response (truncated): $(echo ${SYNC_RESPONSE} | head -c 200)..."
echo ""

# Verify sync mode returns canvases directly (not job_id)
if echo "${SYNC_RESPONSE}" | grep -q '"canvases"'; then
  echo "✅ PASSED: Sync mode returns canvases directly"
elif echo "${SYNC_RESPONSE}" | grep -q '"job_id"'; then
  echo "❌ FAILED: Sync mode incorrectly returned job_id"
else
  echo "⚠️  WARNING: Unexpected sync response format"
fi

echo ""

# Test 6: Priority Queue Routing (soft_proof=true)
echo "Test 6: Priority Queue Routing (soft_proof=true)"
echo "-------------------------------------------"
PRIORITY_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/generate" \
  -H "X-API-Key: ${API_KEY}" \
  -F "layout=classic_4x6" \
  -F "images=@/app/storage/uploads/test_green.png" \
  -F "fit_mode=cover" \
  -F "soft_proof=true" \
  -F "order_id=priority_test_$(date +%s)" \
  -F "callback_url=http://example.com/callback")

echo "Priority Response: ${PRIORITY_RESPONSE}"
echo ""

if echo "${PRIORITY_RESPONSE}" | grep -q '"queue":"priority"'; then
  echo "✅ PASSED: Soft-proof job routed to priority queue"
else
  echo "❌ FAILED: Soft-proof job not routed to priority queue"
fi

echo ""
echo "=========================================="
echo "Verification Complete"
echo "=========================================="
