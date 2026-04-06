# Implementation Plan: Async Image Generation

## Overview

This implementation plan follows a phased approach to build asynchronous image generation using Celery with Redis. The sequence ensures infrastructure is solid before building application logic: Infrastructure → Persistence → Rendering → API → Monitoring → Testing.

Implementation language: Python (Django backend)

## Tasks

- [x] 1. Phase 1: Infrastructure Setup
  - [x] 1.1 Update docker-compose.yml with Celery services
    - Add celery-worker service with memory limit (512MB) and CPU limit (1.0)
    - Add celery-beat service for periodic tasks
    - Configure db service with POSTGRES_MAX_CONNECTIONS=100
    - Configure redis service with memory reservation (128MB)
    - Set user: "1000:1000" for backend, celery-worker, and celery-beat services
    - Add resource limits and health checks
    - _Requirements: 1.5, 13.1, 13.2, 13.3, 13.4, 14.5, 16.1, 16.2_
  
  - [x] 1.2 Update backend Dockerfile for Celery support
    - Ensure appuser is created with UID 1000 and GID 1000
    - Add celery[redis], django-celery-beat, django-celery-results to requirements.txt
    - _Requirements: 16.1, 16.2_
  
  - [x] 1.3 Update entrypoint.sh for multi-service support
    - Add EXPORTS_DIR permission check and auto-fix (0775)
    - Add conditional logic to start celery-worker, celery-beat, or gunicorn based on command argument
    - Ensure migrations run before any service starts
    - _Requirements: 16.3, 16.4, 16.7_
  
  - [x] 1.4 Create Celery configuration
    - Create backend/django/product_editor/celery.py with app initialization
    - Configure Redis broker URL from environment
    - Set worker_prefetch_multiplier=1, worker_max_tasks_per_child=10
    - Configure task_acks_late=True, task_reject_on_worker_lost=True
    - Set result_backend and result_expires=86400
    - Enable worker_send_task_events and task_send_sent_event
    - _Requirements: 1.1, 1.2, 9.3, 14.3, 14.4_
  
  - [x] 1.5 Add Celery settings to Django settings.py
    - Add CELERY_BROKER_URL, CELERY_RESULT_BACKEND from environment
    - Configure CELERY_ACCEPT_CONTENT, CELERY_TASK_SERIALIZER, CELERY_RESULT_SERIALIZER
    - Set CELERY_TIMEZONE='UTC'
    - Add DATABASES['default']['CONN_MAX_AGE'] = 60 for connection pooling
    - Add OMS_PRODUCTION_ESTIMATOR_URL setting
    - _Requirements: 1.1, 14.1, 14.2_
  
  - [x] 1.6 Update product_editor/__init__.py to load Celery app
    - Import celery app to ensure it's loaded when Django starts
    - _Requirements: 1.1_

- [x] 2. Checkpoint - Verify infrastructure
  - Build and start all services: docker-compose up -d
  - Verify celery-worker and celery-beat containers are running
  - Check celery-worker logs for successful startup
  - Verify Redis connection from Django shell

- [x] 3. Phase 2: Persistence Layer
  - [x] 3.1 Create CanvasData model
    - Add CanvasData model to backend/django/api/models.py
    - Fields: id (UUID), order_id (CharField, indexed, unique), api_key (ForeignKey)
    - Fields: layout_name, image_paths (JSONField), fit_mode, export_format, soft_proof
    - Fields: created_at (indexed), expires_at
    - Add requires_manual_review field (BooleanField, default=False)
    - Add Meta class with db_table='canvas_data' and indexes
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 5.4_
  
  - [x] 3.2 Create RenderJob model
    - Add RenderJob model to backend/django/api/models.py
    - Fields: id (UUID), canvas_data (ForeignKey), celery_task_id (CharField, indexed, unique)
    - Fields: status (CharField with choices: queued, processing, completed, failed, indexed)
    - Fields: queue_name (CharField)
    - Fields: output_paths (JSONField), error_message (TextField)
    - Fields: created_at (indexed), started_at, completed_at, generation_time_ms
    - Fields: retry_count (IntegerField, default=0)
    - Add Meta class with db_table='render_jobs' and composite indexes
    - _Requirements: 2.1, 2.5, 3.1, 7.1_
  
  - [x] 3.3 Create and run Django migrations
    - Run python manage.py makemigrations
    - Review generated migration files
    - Run python manage.py migrate
    - _Requirements: 10.1_
  
  - [ ]* 3.4 Write unit tests for database models
    - Test CanvasData creation with all required fields
    - Test RenderJob status transitions
    - Test foreign key relationships
    - Test unique constraints (order_id, celery_task_id)
    - _Requirements: 10.1, 10.2, 10.3_

- [x] 4. Phase 3: Rendering Task Implementation
  - [x] 4.1 Implement atomic file write helper
    - Add _write_output_atomic method to backend/django/layout_engine/engine.py
    - Use tempfile.mkstemp with .tmp suffix in same directory as final file
    - Write image data to temporary file
    - Set file permissions to 0664 (group-writable)
    - Use os.replace() for atomic move to final path
    - Clean up .tmp file on failure
    - Log both temporary write and final move with file path and size
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.7, 16.5_
  
  - [x] 4.2 Update LayoutEngine to use atomic writes
    - Modify generate() method to use _write_output_atomic for all file writes
    - Modify generate_soft_proof() method to use _write_output_atomic
    - Ensure no direct file.save() or open().write() calls remain
    - _Requirements: 15.1, 15.2, 15.3_
  
  - [ ]* 4.3 Write property test for atomic file writes
    - **Property 58: Atomic File Write Pattern**
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4**
    - Test that writes use .tmp files and atomically move to final name
    - Test that failed writes leave no partial files
  
  - [x] 4.4 Create Celery task for rendering
    - Create backend/django/api/tasks.py
    - Implement render_canvas_task with @shared_task decorator
    - Configure bind=True, max_retries=3, default_retry_delay=2
    - Configure autoretry_for=(Exception,), retry_backoff=True, retry_backoff_max=8
    - Configure time_limit=600, soft_time_limit=570
    - Update RenderJob status to 'processing' and set started_at
    - Retrieve CanvasData and execute rendering via LayoutEngine
    - Handle soft_proof mode: call generate_soft_proof() for triple output
    - Handle standard mode: call generate() with export_format
    - Verify all output files exist after rendering
    - Update RenderJob with status='completed', output_paths, generation_time_ms
    - Handle exceptions: increment retry_count, set error_message, mark as 'failed' after 3 retries
    - Log success and failure with job context (job_id, order_id, layout_name)
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6, 6.1, 6.5, 7.1, 7.5, 9.5, 9.6_
  
  - [x] 4.5 Implement Production Estimator push function
    - Create push_to_production_estimator() function in api/tasks.py
    - Build payload with order_id, output_files, layout_name, export_format
    - POST to OMS_PRODUCTION_ESTIMATOR_URL with 10-second timeout
    - Retry up to 5 times with exponential backoff (2^attempt seconds)
    - On final failure: log error and set canvas.requires_manual_review=True
    - Log successful push with order_id
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  
  - [x] 4.6 Call Production Estimator push from render task
    - Add call to push_to_production_estimator() after successful render
    - Pass canvas and output_paths to the function
    - _Requirements: 5.1_
  
  - [ ]* 4.7 Write property test for render job retry
    - **Property 5: Render Job Retry with Exponential Backoff**
    - **Validates: Requirements 2.5**
    - Test that failed jobs retry up to 3 times with correct delays
  
  - [ ]* 4.8 Write property test for Production Estimator push
    - **Property 14: Production Estimator Push on Completion**
    - **Validates: Requirements 5.1, 5.2**
    - Test that completed jobs trigger OMS API call with correct payload
  
  - [ ]* 4.9 Write unit tests for render_canvas_task
    - Test successful render with standard mode
    - Test successful render with soft_proof mode (3 outputs)
    - Test retry behavior on transient failure
    - Test final failure after 3 retries
    - Test file existence verification
    - Test generation_time_ms tracking

- [x] 5. Checkpoint - Verify rendering task
  - Test render_canvas_task execution from Django shell
  - Verify output files are created in EXPORTS_DIR
  - Verify RenderJob status updates correctly
  - Check that .tmp files are cleaned up

- [x] 6. Phase 4: API Endpoints
  - [x] 6.1 Implement async generate endpoint
    - Extend GenerateLayoutView in backend/django/api/views.py
    - Add _handle_async() method to handle callback_url parameter
    - Parse request: layout_name, files, fit_mode, export_format, soft_proof, order_id
    - Validate order_id is present for async mode (return 400 if missing)
    - Save uploaded files to UPLOADS_DIR
    - Use transaction.atomic() to wrap CanvasData creation and job enqueue
    - Create CanvasData with all fields and expires_at = now + 30 days
    - Create RenderJob with queue_name based on soft_proof flag
    - Use transaction.on_commit() to enqueue task after database commit
    - Return 202 response with job_id, status_url, queue, estimated_wait_seconds
    - _Requirements: 2.1, 2.2, 8.3, 10.1, 10.2, 10.3, 10.4, 10.7, 12.2, 12.3_
  
  - [x] 6.2 Implement task enqueue helper
    - Create _enqueue_task() method in GenerateLayoutView
    - Call render_canvas_task.apply_async() with canvas_id and job_id
    - Route to 'priority' or 'standard' queue based on queue_name parameter
    - Update RenderJob with celery_task_id after enqueue
    - _Requirements: 2.1, 12.2, 12.3_
  
  - [x] 6.3 Implement wait time estimation helper
    - Create _estimate_wait_time() method in GenerateLayoutView
    - Query RenderJob count for given queue with status='queued'
    - Return estimated seconds based on queue depth and average processing time
    - _Requirements: 4.2_
  
  - [x] 6.4 Update generate endpoint to support both sync and async
    - Modify post() method to check for callback_url parameter
    - If callback_url present: call _handle_async()
    - If callback_url absent: call existing _handle_sync() (backward compatible)
    - Log which mode is used for each request
    - _Requirements: 8.1, 8.2, 8.3, 8.5_
  
  - [ ]* 6.5 Write property test for non-blocking enqueue
    - **Property 3: Non-Blocking Job Enqueue**
    - **Validates: Requirements 2.1, 2.2**
    - Test that async requests return within 200ms
  
  - [ ]* 6.6 Write property test for transaction commit before enqueue
    - **Property 42: Transaction Commit Before Task Enqueue**
    - **Validates: Requirements 10.7**
    - Test that CanvasData is committed before Celery task is enqueued
  
  - [ ]* 6.7 Write unit tests for async generate endpoint
    - Test async mode returns 202 with job_id and status_url
    - Test sync mode returns 200 with canvases (backward compatible)
    - Test 400 error when order_id missing in async mode
    - Test queue routing based on soft_proof flag
  
  - [x] 6.8 Create job status endpoint
    - Create RenderStatusView in backend/django/api/views.py
    - Add permission_classes = [IsAuthenticatedWithAPIKey]
    - Implement get() method with job_id parameter
    - Check Redis cache first (cache_key = f'render_job_status:{job_id}')
    - If not cached: query RenderJob with select_related('canvas_data')
    - Return 404 if job not found
    - Build response_data with job_id, status, queue, created_at
    - For 'queued': add estimated_wait_seconds
    - For 'processing': add started_at
    - For 'completed': add completed_at, generation_time_ms, output_files (relative paths)
    - For 'failed': add error, retry_count
    - Cache response for 5 seconds
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  
  - [ ]* 6.9 Write property test for job status endpoint
    - **Property 7: Job Status Endpoint Correctness**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5**
    - Test that status endpoint returns correct data for all job states
  
  - [ ]* 6.10 Write property test for status query response time
    - **Property 8: Status Query Response Time**
    - **Validates: Requirements 3.6**
    - Test that status queries respond within 50ms
  
  - [ ]* 6.11 Write unit tests for status endpoint
    - Test status response for queued job
    - Test status response for processing job
    - Test status response for completed job with output files
    - Test status response for failed job with error message
    - Test 404 response for non-existent job
    - Test Redis caching behavior
  
  - [x] 6.12 Create monitoring endpoint for ops team
    - Create CeleryMonitoringView in backend/django/api/views.py
    - Add permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    - Use celery.current_app.control.inspect() to get worker stats
    - Query active_tasks and reserved_tasks
    - Calculate priority_depth and standard_depth from reserved tasks
    - Count workers from stats
    - Query RenderJob counts for queued, processing, completed_24h, failed_24h
    - Return JSON with workers, queues (with alert flags), and jobs sections
    - _Requirements: 7.2, 7.3_
  
  - [ ]* 6.13 Write unit tests for monitoring endpoint
    - Test monitoring response structure
    - Test queue depth calculations
    - Test alert flags when thresholds exceeded
    - Test ops team permission requirement
  
  - [x] 6.14 Add URL routes for new endpoints
    - Add path('render-status/<uuid:job_id>/', RenderStatusView.as_view()) to api/urls.py
    - Add path('celery/monitor/', CeleryMonitoringView.as_view()) to api/urls.py
    - _Requirements: 3.1, 7.2_

- [x] 7. Checkpoint - Verify API endpoints
  - Test async generate endpoint with curl or Postman
  - Verify job_id and status_url are returned
  - Test status endpoint with returned job_id
  - Test monitoring endpoint with ops API key
  - Verify backward compatibility with sync mode

- [x] 8. Phase 5: Monitoring and Cleanup
  - [x] 8.1 Implement garbage collector task
    - Create garbage_collector_task() in backend/django/api/tasks.py
    - Add @shared_task decorator
    - Check disk usage with shutil.disk_usage(EXPORTS_DIR)
    - If usage > 80%: log critical alert and set retention_days=7, else retention_days=14
    - Calculate cutoff_date = now - timedelta(days=retention_days)
    - Query ExportedResult for files older than cutoff_date, exclude requires_manual_review=True
    - For each expired file: delete from filesystem, update is_deleted=True, track deleted_count and deleted_bytes
    - Log summary with deleted count and bytes
    - Return dict with deleted_count, deleted_bytes, disk_usage_percent
    - _Requirements: 11.1, 11.2, 11.4, 11.5, 11.6, 11.7_
  
  - [x] 8.2 Configure Celery beat schedule
    - Add beat_schedule configuration to product_editor/celery.py
    - Schedule garbage_collector_task to run daily at 2 AM UTC using crontab
    - _Requirements: 11.1_
  
  - [ ]* 8.3 Write property test for garbage collection
    - **Property 44: Garbage Collection File Age Detection**
    - **Validates: Requirements 11.2**
    - Test that only files older than retention period are deleted
  
  - [ ]* 8.4 Write property test for manual review preservation
    - **Property 48: Manual Review File Preservation**
    - **Validates: Requirements 11.6**
    - Test that files marked for manual review are preserved
  
  - [ ]* 8.5 Write unit tests for garbage collector
    - Test deletion of files older than 14 days
    - Test preservation of recent files
    - Test preservation of manual review files
    - Test retention reduction when disk usage > 80%
    - Test metrics tracking (deleted_count, deleted_bytes)
  
  - [x] 8.6 Implement queue routing logic
    - Update _enqueue_task() to route based on soft_proof flag
    - If soft_proof=True: route to 'priority' queue
    - If soft_proof=False: route to 'standard' queue
    - _Requirements: 12.2, 12.3_
  
  - [ ]* 8.7 Write property test for queue routing
    - **Property 50: Queue Routing Based on Soft-Proof Flag**
    - **Validates: Requirements 12.2, 12.3**
    - Test that jobs are routed to correct queue based on soft_proof
  
  - [x] 8.8 Configure worker queue allocation
    - Update docker-compose.yml celery-worker command
    - Set -Q priority,standard to listen to both queues
    - Document that 2 workers should be dedicated to priority queue (manual scaling)
    - _Requirements: 12.4, 12.5_
  
  - [x] 8.9 Add queue depth monitoring
    - Update CeleryMonitoringView to expose separate metrics for priority and standard queues
    - Add alert flag when priority_depth > 50
    - Add alert flag when standard_depth > 200
    - _Requirements: 12.7, 12.8_
  
  - [x] 8.10 Add worker memory monitoring
    - Add logging in render_canvas_task to check memory usage
    - Log warning if memory usage > 400MB (80% of 512MB limit)
    - _Requirements: 13.6_
  
  - [x] 8.11 Add graceful failure for large renders
    - Wrap render operations in try/except MemoryError
    - If MemoryError caught: fail job with descriptive message instead of crashing
    - _Requirements: 13.7_

- [x] 9. Checkpoint - Verify monitoring and cleanup
  - Test garbage collector task execution
  - Verify old files are deleted
  - Test queue routing with soft_proof=True and soft_proof=False
  - Check monitoring endpoint for queue depths
  - Verify Celery beat schedule is running

- [x] 10. Phase 6: Testing and Optimization
  - [ ]* 10.1 Write property test for concurrent job processing
    - **Property 9: Concurrent Job Processing Without Timeouts**
    - **Validates: Requirements 4.1**
    - Test that 50+ concurrent jobs complete without timeouts
  
  - [ ]* 10.2 Write property test for render completion SLA (normal load)
    - **Property 12: Render Job Completion SLA (Normal Load)**
    - **Validates: Requirements 4.5**
    - Test that 95% of jobs complete within 5 minutes under normal load
  
  - [ ]* 10.3 Write property test for render completion SLA (peak load)
    - **Property 13: Render Job Completion SLA (Peak Load)**
    - **Validates: Requirements 4.6**
    - Test that 95% of jobs complete within 10 minutes under peak load
  
  - [ ]* 10.4 Write property test for priority queue latency
    - **Property 51: Priority Queue Latency SLA**
    - **Validates: Requirements 12.6**
    - Test that 95% of priority queue jobs complete within 30 seconds
  
  - [ ]* 10.5 Write property test for soft-proof triple output
    - **Property 19: Soft-Proof Triple Output Generation**
    - **Validates: Requirements 6.1**
    - Test that soft-proof mode generates exactly 3 files
  
  - [ ]* 10.6 Write property test for cross-container file deletion
    - **Property 62: Cross-Container File Deletion**
    - **Validates: Requirements 16.6**
    - Test that files created by workers can be deleted by web container
  
  - [ ]* 10.7 Write integration test for end-to-end async workflow
    - Test complete workflow: enqueue → status query → completion → file verification
    - Verify job transitions through queued → processing → completed states
    - Verify output files exist and are accessible
  
  - [x] 10.8 Add database indexes for performance
    - Verify indexes exist on CanvasData.order_id, CanvasData.created_at
    - Verify indexes exist on RenderJob.celery_task_id, RenderJob.status + created_at
    - Run EXPLAIN ANALYZE on common queries to verify index usage
    - _Requirements: 3.6_
  
  - [x] 10.9 Optimize Redis cache TTLs
    - Review cache TTL for job status (currently 5 seconds)
    - Adjust based on status query patterns from load testing
    - _Requirements: 3.6, 3.7_
  
  - [ ]* 10.10 Run load tests with locust
    - Configure locust test with 10 concurrent users (normal load)
    - Configure locust test with 50 concurrent users (peak load)
    - Verify 95% of requests complete within SLA
    - Verify error rate < 1%
    - Verify no worker crashes
  
  - [x] 10.11 Performance tuning based on load test results
    - Adjust worker concurrency if needed
    - Tune database connection pool settings
    - Optimize file I/O patterns if bottlenecks identified
    - Document performance characteristics and scaling recommendations

- [x] 11. Final checkpoint - Production readiness
  - Run full test suite: pytest tests/ -v
  - Run property tests with 100 examples
  - Verify all services start correctly with docker-compose up
  - Test backward compatibility with existing sync mode
  - Review logs for any warnings or errors
  - Document deployment steps and monitoring procedures

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at each phase
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- Implementation follows the phased approach from the design document
- Python is used for all backend implementation (Django + Celery)
