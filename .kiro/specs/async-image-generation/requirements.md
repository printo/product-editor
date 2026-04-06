# Requirements Document

## Introduction

The Product Editor currently uses synchronous image generation that blocks Gunicorn worker threads during rendering operations. Under sustained load (>50 concurrent orders), this causes request timeouts and prevents reliable operation during peak periods like festivals. This feature implements an asynchronous task queue using Celery with Redis as the message broker to enable non-blocking image generation that can scale horizontally to handle concurrent orders.

## Glossary

- **Image_Generator**: The backend service responsible for rendering canvas layouts into production-ready image files (PNG, TIFF_CMYK)
- **Task_Queue**: Celery-based distributed task queue that manages asynchronous job execution
- **Redis_Broker**: Redis instance acting as the message broker for Celery task distribution
- **Gunicorn_Worker**: Django application server worker process that handles HTTP requests
- **Canvas_Data**: JSON representation of customer-approved layout including images, overlays, and positioning
- **Render_Job**: An asynchronous task that generates production-ready images from Canvas_Data
- **Job_Status**: The current state of a Render_Job (queued, processing, completed, failed)
- **Production_Estimator**: Downstream system that receives completed render outputs for print production
- **Checkout_Flow**: The customer payment and order confirmation process
- **OMS**: Order Management System that tracks order lifecycle and integrates with production
- **EXPORTS_DIR**: S3-compatible storage bucket for rendered output files
- **Garbage_Collector**: Background service that purges expired files from EXPORTS_DIR
- **Priority_Queue**: High-priority task queue for real-time preview and soft-proof requests
- **Standard_Queue**: Default task queue for bulk production order fulfillment
- **Celery_Worker**: Docker container running Celery worker processes for asynchronous task execution
- **Web_Container**: Docker container running Django application with Gunicorn
- **Postgres_Container**: Docker container running PostgreSQL database service
- **Connection_Pool**: Database connection management strategy to limit concurrent connections per worker
- **Atomic_Write**: File write strategy that ensures complete file writes before making files visible to readers
- **Shared_Volume**: Docker volume mounted across multiple containers for file sharing

## Requirements

### Requirement 1: Celery Task Queue Infrastructure

**User Story:** As a system administrator, I want Celery task queue infrastructure deployed with Redis broker, so that the system can process image generation jobs asynchronously.

#### Acceptance Criteria

1. THE Task_Queue SHALL use Redis_Broker for message distribution
2. THE Task_Queue SHALL support at least 4 concurrent worker processes
3. WHEN Redis_Broker becomes unavailable, THE Task_Queue SHALL log connection errors and retry with exponential backoff
4. THE Task_Queue SHALL persist task state in Redis_Broker with a TTL of 24 hours
5. THE Task_Queue SHALL be deployed as a separate Docker service in docker-compose.yml
6. THE Task_Queue SHALL share the same Redis instance already configured for Django cache

### Requirement 2: Non-Blocking Image Generation

**User Story:** As a backend developer, I want image generation to execute asynchronously, so that Gunicorn workers remain available to handle incoming requests.

#### Acceptance Criteria

1. WHEN a customer completes Checkout_Flow, THE Image_Generator SHALL enqueue a Render_Job without blocking the HTTP response
2. THE Gunicorn_Worker SHALL return a job identifier and status URL within 200ms of receiving the generation request
3. THE Render_Job SHALL execute in a Celery worker process separate from Gunicorn_Worker processes
4. WHEN a Render_Job completes successfully, THE Image_Generator SHALL store output files in EXPORTS_DIR
5. WHEN a Render_Job fails, THE Task_Queue SHALL retry up to 3 times with exponential backoff (2s, 4s, 8s)
6. IF all retry attempts fail, THEN THE Task_Queue SHALL mark the job as failed and log the error details

### Requirement 3: Job Status Tracking

**User Story:** As a frontend developer, I want to query the status of image generation jobs, so that I can display progress to customers.

#### Acceptance Criteria

1. THE Image_Generator SHALL provide a REST API endpoint to query Job_Status by job identifier
2. WHEN a job is queued, THE endpoint SHALL return Job_Status "queued" with estimated wait time
3. WHILE a job is processing, THE endpoint SHALL return Job_Status "processing" with progress percentage if available
4. WHEN a job completes, THE endpoint SHALL return Job_Status "completed" with output file paths
5. IF a job fails, THEN THE endpoint SHALL return Job_Status "failed" with error message
6. THE endpoint SHALL respond within 50ms for status queries
7. THE Job_Status SHALL be cached in Redis_Broker to minimize database queries

### Requirement 4: Concurrent Order Handling

**User Story:** As a business stakeholder, I want the system to handle more than 50 concurrent orders, so that we can serve customers reliably during peak periods.

#### Acceptance Criteria

1. THE Task_Queue SHALL process at least 50 concurrent Render_Jobs without timeout errors
2. WHEN queue depth exceeds 100 jobs, THE Image_Generator SHALL return estimated wait time in the API response
3. THE Task_Queue SHALL scale horizontally by adding worker processes without code changes
4. WHEN system load is high, THE Gunicorn_Worker SHALL remain responsive to health check requests
5. THE Image_Generator SHALL complete 95% of Render_Jobs within 5 minutes under normal load
6. THE Image_Generator SHALL complete 95% of Render_Jobs within 10 minutes under peak load (>50 concurrent)

### Requirement 5: Production Integration

**User Story:** As a production team member, I want completed render jobs automatically pushed to the Production_Estimator, so that orders flow directly to print without manual handoff.

#### Acceptance Criteria

1. WHEN a Render_Job completes successfully, THE Image_Generator SHALL push output file paths to Production_Estimator via OMS API
2. THE Image_Generator SHALL include order metadata (order_id, SKU, quantity, customer_id) in the Production_Estimator payload
3. IF the Production_Estimator API call fails, THEN THE Image_Generator SHALL retry up to 5 times with exponential backoff
4. IF all Production_Estimator retry attempts fail, THEN THE Image_Generator SHALL log the failure and mark the job for manual review
5. THE Image_Generator SHALL track the end-to-end latency from Checkout_Flow completion to Production_Estimator receipt
6. THE Image_Generator SHALL log a warning if end-to-end latency exceeds 5 minutes

### Requirement 6: Soft-Proof CMYK Pipeline

**User Story:** As a production team member, I want CMYK soft-proof generation to run asynchronously, so that colour-accurate press output does not block order processing.

#### Acceptance Criteria

1. WHEN soft_proof mode is enabled, THE Image_Generator SHALL enqueue a Render_Job that generates PNG, TIFF_CMYK, and CMYK_preview outputs
2. THE Render_Job SHALL apply ISOcoated_v2 ICC profile for CMYK conversion
3. THE Render_Job SHALL calculate colour shift metrics (avg_diff, max_pixel_diff, significant flag)
4. WHEN colour shift is significant (avg_diff > 8/255), THE Image_Generator SHALL include a warning in the Job_Status response
5. THE Render_Job SHALL store all three output files (PNG, TIFF_CMYK, CMYK_preview) in EXPORTS_DIR with consistent naming
6. THE Image_Generator SHALL track colour shift metrics in ExportedResult database records

### Requirement 7: Error Handling and Monitoring

**User Story:** As a system administrator, I want comprehensive error logging and monitoring, so that I can diagnose and resolve issues quickly.

#### Acceptance Criteria

1. WHEN a Render_Job fails, THE Task_Queue SHALL log the full error traceback with job context (order_id, layout_name, input files)
2. THE Task_Queue SHALL expose Celery metrics (queue depth, worker utilization, task success/failure rates) via a monitoring endpoint
3. WHEN queue depth exceeds 200 jobs, THE Task_Queue SHALL log a critical alert
4. WHEN worker process crashes, THE Task_Queue SHALL restart the worker automatically and log the crash details
5. THE Image_Generator SHALL track generation_time_ms for each Render_Job and log a warning if it exceeds 300 seconds
6. THE Task_Queue SHALL provide a dead letter queue for jobs that fail after all retry attempts
7. THE Task_Queue SHALL implement I/O throttling to limit concurrent disk write operations to 10 per worker when EXPORTS_DIR is mounted as a shared network volume

### Requirement 8: Backward Compatibility

**User Story:** As a backend developer, I want the async implementation to maintain API compatibility, so that existing integrations continue to work without changes.

#### Acceptance Criteria

1. THE Image_Generator SHALL maintain the existing /api/generate endpoint signature
2. WHEN a client does not provide a callback URL, THE Image_Generator SHALL default to synchronous behavior with a 300-second timeout
3. WHEN a client provides a callback URL, THE Image_Generator SHALL enqueue the job and return immediately with job identifier
4. THE Image_Generator SHALL support both sync and async modes during a transition period
5. THE Image_Generator SHALL log which mode (sync/async) is used for each request for monitoring purposes

### Requirement 9: Resource Management

**User Story:** As a system administrator, I want task queue resource limits configured, so that the system remains stable under load.

#### Acceptance Criteria

1. THE Task_Queue SHALL limit memory usage per worker process to 512MB
2. WHEN a worker process exceeds memory limit, THE Task_Queue SHALL gracefully restart the worker after completing current task
3. THE Task_Queue SHALL limit concurrent tasks per worker to 1 to prevent resource contention
4. THE Redis_Broker SHALL use allkeys-lru eviction policy with 256MB maxmemory limit
5. THE Task_Queue SHALL implement task timeout of 600 seconds (10 minutes) per Render_Job
6. WHEN a task exceeds timeout, THE Task_Queue SHALL terminate the task and mark it as failed
7. THE EXPORTS_DIR SHALL be configured as an S3-compatible bucket to prevent local disk IOPS saturation

### Requirement 10: Canvas State Persistence

**User Story:** As a customer, I want my approved canvas design saved after checkout, so that the system can generate the final output even if I navigate away.

#### Acceptance Criteria

1. WHEN a customer approves a canvas design, THE Image_Generator SHALL persist Canvas_Data to the database
2. THE Canvas_Data SHALL include layout_name, image file paths, fit_mode, export_format, and all overlay configurations
3. THE Canvas_Data SHALL be associated with the order_id from OMS
4. WHEN Checkout_Flow completes, THE Image_Generator SHALL retrieve Canvas_Data by order_id to enqueue the Render_Job
5. THE Canvas_Data SHALL remain stored for 30 days after order completion for audit purposes
6. IF Canvas_Data retrieval fails, THEN THE Image_Generator SHALL return an error to the customer and prevent checkout completion
7. THE Image_Generator SHALL enqueue Render_Jobs using transaction.on_commit() to ensure Canvas_Data is committed before task execution
8. WHEN Canvas_Data is not found during Render_Job execution, THE Task_Queue SHALL retry the task after a 2-second delay to handle race conditions with payment gateway webhooks

### Requirement 11: Storage Lifecycle Management

**User Story:** As a system administrator, I want automatic cleanup of expired render outputs, so that disk space consumption remains manageable under sustained load.

#### Acceptance Criteria

1. THE Garbage_Collector SHALL run as a scheduled Celery periodic task every 24 hours
2. THE Garbage_Collector SHALL identify files in EXPORTS_DIR older than 14 days
3. WHEN Production_Estimator confirms receipt of output files, THE Garbage_Collector SHALL mark those files eligible for deletion after 7 days instead of 14 days
4. THE Garbage_Collector SHALL delete eligible files from EXPORTS_DIR and log the file paths and deletion timestamps
5. WHEN EXPORTS_DIR disk usage exceeds 80% capacity, THE Garbage_Collector SHALL log a critical alert and reduce retention to 7 days for all files
6. THE Garbage_Collector SHALL preserve files associated with orders marked for manual review regardless of age
7. THE Garbage_Collector SHALL track total bytes deleted per execution and expose this metric via the monitoring endpoint

### Requirement 12: Priority Queue Management

**User Story:** As a customer, I want real-time preview generation to complete quickly, so that I don't wait behind hundreds of bulk production jobs.

#### Acceptance Criteria

1. THE Task_Queue SHALL implement two separate queues: Priority_Queue and Standard_Queue
2. WHEN a Render_Job is enqueued with soft_proof mode enabled, THE Image_Generator SHALL route it to Priority_Queue
3. WHEN a Render_Job is enqueued from Checkout_Flow without soft_proof mode, THE Image_Generator SHALL route it to Standard_Queue
4. THE Task_Queue SHALL allocate at least 2 dedicated worker processes to Priority_Queue
5. THE Task_Queue SHALL allocate remaining worker processes to Standard_Queue
6. THE Priority_Queue SHALL process jobs with a target latency of 30 seconds for 95th percentile
7. WHEN Priority_Queue depth exceeds 50 jobs, THE Task_Queue SHALL log a warning and temporarily allocate additional workers from Standard_Queue
8. THE Image_Generator SHALL expose separate queue depth metrics for Priority_Queue and Standard_Queue via the monitoring endpoint

### Requirement 13: Docker Resource Limits

**User Story:** As a system administrator, I want Docker resource limits configured in docker-compose.yml, so that Celery workers cannot starve the database of resources during heavy rendering.

#### Acceptance Criteria

1. THE Celery_Worker service SHALL be configured with a memory limit of 512MB in docker-compose.yml
2. THE Celery_Worker service SHALL be configured with a CPU limit of 1.0 CPU share in docker-compose.yml
3. THE Postgres_Container SHALL be configured with a memory reservation of 256MB to guarantee minimum available memory
4. THE Redis_Broker SHALL be configured with a memory reservation of 128MB to guarantee minimum available memory
5. WHEN a Celery_Worker exceeds its 512MB memory limit, Docker SHALL terminate that worker container and restart it automatically
6. THE Task_Queue SHALL log a warning when worker memory usage exceeds 400MB (80% of limit)
7. WHEN a TIFF render operation requires more than 512MB RAM, THE Image_Generator SHALL fail the job with a descriptive error message rather than causing container termination

### Requirement 14: Database Connection Pooling

**User Story:** As a system administrator, I want database connection pooling configured, so that scaling to 10 workers does not exhaust Postgres max_connections.

#### Acceptance Criteria

1. THE Web_Container SHALL configure Django DATABASES setting with CONN_MAX_AGE of 60 seconds to enable persistent connections
2. THE Celery_Worker SHALL configure Django DATABASES setting with CONN_MAX_AGE of 60 seconds to enable persistent connections
3. THE Celery_Worker entrypoint script SHALL include --max-tasks-per-child=10 flag to recycle worker processes and clear stale connections
4. WHEN a Celery_Worker completes 10 tasks, THE Task_Queue SHALL gracefully restart that worker process to prevent memory leaks
5. THE Postgres_Container SHALL be configured with max_connections=100 to accommodate up to 10 workers with 5 connections each plus Web_Container connections
6. WHEN database connection pool is exhausted, THE Image_Generator SHALL log a critical error with connection count metrics
7. THE Task_Queue SHALL close database connections before worker process restart to prevent connection leaks

### Requirement 15: Atomic File Writes

**User Story:** As a production team member, I want rendered images written atomically, so that I never receive corrupted or partial files from EXPORTS_DIR.

#### Acceptance Criteria

1. WHEN writing a rendered image to EXPORTS_DIR, THE Image_Generator SHALL write to a temporary file with .tmp extension first
2. WHILE the render is in progress, THE temporary file SHALL not be visible to Production_Estimator or other downstream services
3. WHEN the render completes successfully, THE Image_Generator SHALL use os.replace() to atomically move the .tmp file to its final filename
4. IF the render fails or is interrupted, THEN THE Image_Generator SHALL delete the .tmp file and not leave partial files in EXPORTS_DIR
5. THE Image_Generator SHALL ensure the atomic move operation is performed on the same filesystem to guarantee atomicity
6. WHEN Production_Estimator reads files from EXPORTS_DIR, it SHALL only see complete files without .tmp extension
7. THE Image_Generator SHALL log the file path and size for both temporary write and final atomic move operations

### Requirement 16: Shared Volume Permissions

**User Story:** As a system administrator, I want consistent file permissions across Web and Worker containers, so that the Garbage_Collector can delete files created by rendering workers.

#### Acceptance Criteria

1. THE Web_Container Dockerfile SHALL create appuser with UID 1000 and GID 1000
2. THE Celery_Worker Dockerfile SHALL create appuser with UID 1000 and GID 1000 matching the Web_Container
3. THE Web_Container entrypoint script SHALL ensure EXPORTS_DIR has write permissions (0775) for the appuser group before starting services
4. THE Celery_Worker entrypoint script SHALL ensure EXPORTS_DIR has write permissions (0775) for the appuser group before starting workers
5. WHEN a Celery_Worker writes a file to EXPORTS_DIR, THE file SHALL be created with group-writable permissions (0664)
6. WHEN the Garbage_Collector running in Web_Container attempts to delete a file created by Celery_Worker, THE deletion SHALL succeed without permission errors
7. THE Image_Generator SHALL log a warning if EXPORTS_DIR permissions are incorrect at startup and attempt to fix them automatically
