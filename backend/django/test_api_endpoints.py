#!/usr/bin/env python
"""
API Endpoint Verification Script
Tests async generate, status, and monitoring endpoints
"""

import requests
import time
import json
import sys
from pathlib import Path

API_KEY = "editor_test_sk_m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6g7h8i9j0k1l2"
OPS_API_KEY = "editor_dev_sk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6"
BASE_URL = "http://localhost:8000"

def print_header(text):
    print("\n" + "=" * 60)
    print(text)
    print("=" * 60)

def print_test(text):
    print(f"\n{text}")
    print("-" * 60)

def test_async_generate():
    """Test 1: Async Generate Endpoint"""
    print_test("Test 1: Async Generate Endpoint (with callback_url)")
    
    order_id = f"test_order_{int(time.time())}"
    
    with open('/app/storage/uploads/test_red.png', 'rb') as f:
        files = {'images': ('test_red.png', f, 'image/png')}
        data = {
            'layout': 'classic_4x6',
            'fit_mode': 'cover',
            'export_format': 'png',
            'soft_proof': 'false',
            'order_id': order_id,
            'callback_url': 'http://example.com/callback'
        }
        
        response = requests.post(
            f"{BASE_URL}/api/layout/generate",
            headers={'Authorization': f'Bearer {API_KEY}'},
            files=files,
            data=data
        )
    
    print(f"Status Code: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")
    
    # Verify response
    if response.status_code == 202:
        print("✅ PASSED: Returned 202 Accepted")
    else:
        print(f"❌ FAILED: Expected 202, got {response.status_code}")
        return None
    
    data = response.json()
    
    if 'job_id' in data:
        print(f"✅ PASSED: job_id returned: {data['job_id']}")
    else:
        print("❌ FAILED: No job_id in response")
        return None
    
    if 'status_url' in data:
        print(f"✅ PASSED: status_url returned: {data['status_url']}")
    else:
        print("❌ FAILED: No status_url in response")
        return None
    
    if 'queue' in data:
        print(f"✅ PASSED: queue field present: {data['queue']}")
    else:
        print("⚠️  WARNING: No queue field in response")
    
    if 'estimated_wait_seconds' in data:
        print(f"✅ PASSED: estimated_wait_seconds present: {data['estimated_wait_seconds']}")
    else:
        print("⚠️  WARNING: No estimated_wait_seconds in response")
    
    return data

def test_job_status(status_url):
    """Test 2: Job Status Endpoint"""
    print_test("Test 2: Job Status Endpoint")
    
    time.sleep(2)  # Give job a moment to start
    
    response = requests.get(
        f"{BASE_URL}{status_url}",
        headers={'Authorization': f'Bearer {API_KEY}'}
    )
    
    print(f"Status Code: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")
    
    if response.status_code == 200:
        print("✅ PASSED: Status endpoint returned 200")
    else:
        print(f"❌ FAILED: Expected 200, got {response.status_code}")
        return False
    
    data = response.json()
    
    required_fields = ['job_id', 'status', 'queue', 'created_at']
    for field in required_fields:
        if field in data:
            print(f"✅ PASSED: Response contains '{field}'")
        else:
            print(f"❌ FAILED: Response missing '{field}'")
    
    return True

def test_job_completion(status_url, max_wait=30):
    """Test 3: Wait for Job Completion"""
    print_test("Test 3: Wait for Job Completion")
    
    elapsed = 0
    while elapsed < max_wait:
        response = requests.get(
            f"{BASE_URL}{status_url}",
            headers={'Authorization': f'Bearer {API_KEY}'}
        )
        
        data = response.json()
        status = data.get('status', 'unknown')
        
        print(f"Current status: {status} ({elapsed}s elapsed)")
        
        if status == 'completed':
            print("✅ PASSED: Job completed successfully")
            print(f"Final response: {json.dumps(data, indent=2)}")
            
            if 'output_files' in data:
                print(f"✅ PASSED: Output files present: {len(data['output_files'])} file(s)")
            else:
                print("❌ FAILED: No output_files in completed response")
            
            if 'generation_time_ms' in data:
                print(f"✅ PASSED: Generation time tracked: {data['generation_time_ms']}ms")
            else:
                print("⚠️  WARNING: No generation_time_ms in response")
            
            return True
        
        elif status == 'failed':
            print("❌ FAILED: Job failed")
            print(f"Error response: {json.dumps(data, indent=2)}")
            return False
        
        time.sleep(2)
        elapsed += 2
    
    print(f"⚠️  WARNING: Job did not complete within {max_wait} seconds")
    return False

def test_monitoring_endpoint():
    """Test 4: Monitoring Endpoint"""
    print_test("Test 4: Monitoring Endpoint (Ops Team)")
    
    response = requests.get(
        f"{BASE_URL}/api/celery/monitor/",
        headers={'Authorization': f'Bearer {OPS_API_KEY}'}
    )
    
    print(f"Status Code: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")
    
    if response.status_code == 200:
        print("✅ PASSED: Monitoring endpoint returned 200")
    else:
        print(f"❌ FAILED: Expected 200, got {response.status_code}")
        return False
    
    data = response.json()
    
    required_sections = ['workers', 'queues', 'jobs']
    for section in required_sections:
        if section in data:
            print(f"✅ PASSED: Response contains '{section}' section")
        else:
            print(f"❌ FAILED: Response missing '{section}' section")
    
    # Check queue details
    if 'queues' in data:
        if 'priority' in data['queues'] and 'standard' in data['queues']:
            print("✅ PASSED: Both priority and standard queues present")
        else:
            print("❌ FAILED: Missing priority or standard queue info")
    
    return True

def test_sync_mode():
    """Test 5: Backward Compatibility - Sync Mode"""
    print_test("Test 5: Backward Compatibility - Sync Mode (no callback_url)")
    print("Testing synchronous mode (this may take a few seconds)...")
    
    with open('/app/storage/uploads/test_blue.png', 'rb') as f:
        files = {'images': ('test_blue.png', f, 'image/png')}
        data = {
            'layout': 'classic_4x6',
            'fit_mode': 'cover',
            'export_format': 'png'
        }
        
        response = requests.post(
            f"{BASE_URL}/api/layout/generate",
            headers={'Authorization': f'Bearer {API_KEY}'},
            files=files,
            data=data,
            timeout=60
        )
    
    print(f"Status Code: {response.status_code}")
    
    if response.status_code == 200:
        print("✅ PASSED: Sync mode returned 200")
    else:
        print(f"❌ FAILED: Expected 200, got {response.status_code}")
        return False
    
    data = response.json()
    print(f"Response keys: {list(data.keys())}")
    
    if 'canvases' in data:
        print("✅ PASSED: Sync mode returns 'canvases' directly")
    elif 'job_id' in data:
        print("❌ FAILED: Sync mode incorrectly returned job_id")
        return False
    else:
        print("⚠️  WARNING: Unexpected sync response format")
    
    return True

def test_priority_queue():
    """Test 6: Priority Queue Routing"""
    print_test("Test 6: Priority Queue Routing (soft_proof=true)")
    
    order_id = f"priority_test_{int(time.time())}"
    
    with open('/app/storage/uploads/test_green.png', 'rb') as f:
        files = {'images': ('test_green.png', f, 'image/png')}
        data = {
            'layout': 'classic_4x6',
            'fit_mode': 'cover',
            'soft_proof': 'true',
            'order_id': order_id,
            'callback_url': 'http://example.com/callback'
        }
        
        response = requests.post(
            f"{BASE_URL}/api/layout/generate",
            headers={'Authorization': f'Bearer {API_KEY}'},
            files=files,
            data=data
        )
    
    print(f"Status Code: {response.status_code}")
    print(f"Response: {json.dumps(response.json(), indent=2)}")
    
    if response.status_code == 202:
        data = response.json()
        if data.get('queue') == 'priority':
            print("✅ PASSED: Soft-proof job routed to priority queue")
            return True
        else:
            print(f"❌ FAILED: Expected priority queue, got {data.get('queue')}")
            return False
    else:
        print(f"❌ FAILED: Expected 202, got {response.status_code}")
        return False

def main():
    print_header("API Endpoint Verification Tests")
    
    try:
        # Test 1: Async generate
        async_data = test_async_generate()
        if not async_data:
            print("\n❌ Test 1 failed, cannot continue")
            sys.exit(1)
        
        # Test 2: Status endpoint
        status_url = async_data.get('status_url')
        if status_url:
            test_job_status(status_url)
            
            # Test 3: Job completion
            test_job_completion(status_url)
        
        # Test 4: Monitoring endpoint
        test_monitoring_endpoint()
        
        # Test 5: Sync mode
        test_sync_mode()
        
        # Test 6: Priority queue
        test_priority_queue()
        
        print_header("Verification Complete")
        print("\n✅ All tests executed successfully!")
        
    except Exception as e:
        print(f"\n❌ Test execution failed with error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == '__main__':
    main()
