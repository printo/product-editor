"""
Background Processing Queue for AI Operations
Handles timeout scenarios with background processing and retry mechanisms
"""
import logging
import threading
import queue
import time
from typing import Dict, Any, Optional, Callable, List
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime, timedelta
import uuid
from django.core.cache import cache

logger = logging.getLogger(__name__)


class JobStatus(Enum):
    """Background job status"""
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobPriority(Enum):
    """Job priority levels"""
    LOW = 1
    NORMAL = 2
    HIGH = 3
    URGENT = 4


@dataclass
class BackgroundJob:
    """Background processing job"""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    service_name: str = ""
    function_name: str = ""
    args: tuple = field(default_factory=tuple)
    kwargs: dict = field(default_factory=dict)
    priority: JobPriority = JobPriority.NORMAL
    status: JobStatus = JobStatus.QUEUED
    created_at: datetime = field(default_factory=datetime.now)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    result: Optional[Any] = None
    error_message: Optional[str] = None
    retry_count: int = 0
    max_retries: int = 3
    timeout_seconds: int = 300
    user_id: Optional[str] = None
    callback_url: Optional[str] = None


class BackgroundProcessor:
    """Processes AI operations in the background with retry logic"""
    
    def __init__(self, max_workers: int = 3):
        self.max_workers = max_workers
        self.job_queue = queue.PriorityQueue()
        self.active_jobs: Dict[str, BackgroundJob] = {}
        self.completed_jobs: Dict[str, BackgroundJob] = {}
        self.workers: List[threading.Thread] = []
        self.running = False
        self._lock = threading.Lock()
        
        # Service function registry
        self.service_functions: Dict[str, Dict[str, Callable]] = {}
        
        logger.info(f"Background Processor initialized with {max_workers} workers")
    
    def start(self):
        """Start background processing workers"""
        if self.running:
            return
        
        self.running = True
        
        # Start worker threads
        for i in range(self.max_workers):
            worker = threading.Thread(target=self._worker_loop, name=f"BGWorker-{i}")
            worker.daemon = True
            worker.start()
            self.workers.append(worker)
        
        logger.info(f"Started {len(self.workers)} background workers")
    
    def stop(self):
        """Stop background processing"""
        self.running = False
        
        # Add sentinel values to wake up workers
        for _ in range(self.max_workers):
            self.job_queue.put((0, None))
        
        # Wait for workers to finish
        for worker in self.workers:
            worker.join(timeout=5)
        
        self.workers.clear()
        logger.info("Background processor stopped")
    
    def register_service_function(self, service_name: str, function_name: str, func: Callable):
        """Register a service function for background processing"""
        if service_name not in self.service_functions:
            self.service_functions[service_name] = {}
        
        self.service_functions[service_name][function_name] = func
        logger.debug(f"Registered {service_name}.{function_name} for background processing")
    
    def queue_job(self, service_name: str, function_name: str, *args, 
                  priority: JobPriority = JobPriority.NORMAL,
                  timeout_seconds: int = 300,
                  max_retries: int = 3,
                  user_id: Optional[str] = None,
                  callback_url: Optional[str] = None,
                  **kwargs) -> str:
        """Queue a job for background processing"""
        
        job = BackgroundJob(
            service_name=service_name,
            function_name=function_name,
            args=args,
            kwargs=kwargs,
            priority=priority,
            timeout_seconds=timeout_seconds,
            max_retries=max_retries,
            user_id=user_id,
            callback_url=callback_url
        )
        
        # Store job in cache for persistence
        cache.set(f"bg_job_{job.id}", job, timeout=86400)  # 24 hours
        
        # Add to queue with priority
        priority_value = priority.value
        self.job_queue.put((priority_value, job))
        
        logger.info(f"Queued background job {job.id}: {service_name}.{function_name}")
        return job.id
    
    def get_job_status(self, job_id: str) -> Optional[BackgroundJob]:
        """Get status of a background job"""
        
        # Check active jobs first
        with self._lock:
            if job_id in self.active_jobs:
                return self.active_jobs[job_id]
            
            if job_id in self.completed_jobs:
                return self.completed_jobs[job_id]
        
        # Check cache
        job = cache.get(f"bg_job_{job_id}")
        return job
    
    def cancel_job(self, job_id: str) -> bool:
        """Cancel a queued or active job"""
        
        # Try to cancel from cache
        job = cache.get(f"bg_job_{job_id}")
        if job and job.status in [JobStatus.QUEUED, JobStatus.PROCESSING]:
            job.status = JobStatus.CANCELLED
            cache.set(f"bg_job_{job_id}", job, timeout=86400)
            
            with self._lock:
                if job_id in self.active_jobs:
                    self.active_jobs[job_id].status = JobStatus.CANCELLED
            
            logger.info(f"Cancelled background job {job_id}")
            return True
        
        return False
    
    def get_user_jobs(self, user_id: str, limit: int = 20) -> List[BackgroundJob]:
        """Get recent jobs for a user"""
        jobs = []
        
        # This is a simplified implementation
        # In production, you'd want to use a proper database query
        with self._lock:
            for job in list(self.active_jobs.values()) + list(self.completed_jobs.values()):
                if job.user_id == user_id:
                    jobs.append(job)
        
        # Sort by creation time, most recent first
        jobs.sort(key=lambda x: x.created_at, reverse=True)
        return jobs[:limit]
    
    def _worker_loop(self):
        """Main worker loop for processing background jobs"""
        worker_name = threading.current_thread().name
        logger.info(f"Background worker {worker_name} started")
        
        while self.running:
            try:
                # Get job from queue (blocks until available)
                priority, job = self.job_queue.get(timeout=1)
                
                # Sentinel value to stop worker
                if job is None:
                    break
                
                # Check if job was cancelled
                if job.status == JobStatus.CANCELLED:
                    continue
                
                # Process the job
                self._process_job(job, worker_name)
                
            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"Worker {worker_name} error: {e}")
        
        logger.info(f"Background worker {worker_name} stopped")
    
    def _process_job(self, job: BackgroundJob, worker_name: str):
        """Process a single background job"""
        
        job.status = JobStatus.PROCESSING
        job.started_at = datetime.now()
        
        # Move to active jobs
        with self._lock:
            self.active_jobs[job.id] = job
        
        # Update cache
        cache.set(f"bg_job_{job.id}", job, timeout=86400)
        
        logger.info(f"Worker {worker_name} processing job {job.id}: {job.service_name}.{job.function_name}")
        
        try:
            # Get the service function
            if job.service_name not in self.service_functions:
                raise ValueError(f"Unknown service: {job.service_name}")
            
            if job.function_name not in self.service_functions[job.service_name]:
                raise ValueError(f"Unknown function: {job.service_name}.{job.function_name}")
            
            func = self.service_functions[job.service_name][job.function_name]
            
            # Execute with timeout
            result = self._execute_with_timeout(func, job.timeout_seconds, *job.args, **job.kwargs)
            
            # Job completed successfully
            job.status = JobStatus.COMPLETED
            job.completed_at = datetime.now()
            job.result = result
            
            logger.info(f"Job {job.id} completed successfully")
            
        except Exception as e:
            job.error_message = str(e)
            job.retry_count += 1
            
            logger.error(f"Job {job.id} failed (attempt {job.retry_count}): {e}")
            
            # Retry if under limit
            if job.retry_count < job.max_retries:
                job.status = JobStatus.QUEUED
                
                # Calculate retry delay (exponential backoff)
                delay = min(300, 2 ** job.retry_count * 10)  # Max 5 minutes
                
                # Re-queue with delay
                def requeue_job():
                    time.sleep(delay)
                    if self.running:
                        self.job_queue.put((job.priority.value, job))
                
                retry_thread = threading.Thread(target=requeue_job)
                retry_thread.daemon = True
                retry_thread.start()
                
                logger.info(f"Job {job.id} queued for retry in {delay} seconds")
            else:
                job.status = JobStatus.FAILED
                job.completed_at = datetime.now()
                logger.error(f"Job {job.id} failed permanently after {job.retry_count} attempts")
        
        finally:
            # Move from active to completed
            with self._lock:
                if job.id in self.active_jobs:
                    del self.active_jobs[job.id]
                self.completed_jobs[job.id] = job
            
            # Update cache
            cache.set(f"bg_job_{job.id}", job, timeout=86400)
            
            # Cleanup old completed jobs (keep last 100)
            self._cleanup_completed_jobs()
    
    def _execute_with_timeout(self, func: Callable, timeout: int, *args, **kwargs):
        """Execute function with timeout"""
        result = [None]
        exception = [None]
        
        def target():
            try:
                result[0] = func(*args, **kwargs)
            except Exception as e:
                exception[0] = e
        
        thread = threading.Thread(target=target)
        thread.daemon = True
        thread.start()
        thread.join(timeout)
        
        if thread.is_alive():
            raise TimeoutError(f"Function execution timed out after {timeout} seconds")
        
        if exception[0]:
            raise exception[0]
        
        return result[0]
    
    def _cleanup_completed_jobs(self):
        """Clean up old completed jobs to prevent memory leaks"""
        with self._lock:
            if len(self.completed_jobs) > 100:
                # Keep only the 50 most recent jobs
                sorted_jobs = sorted(
                    self.completed_jobs.items(),
                    key=lambda x: x[1].completed_at or datetime.min,
                    reverse=True
                )
                
                # Keep first 50, remove the rest
                jobs_to_keep = dict(sorted_jobs[:50])
                jobs_to_remove = [job_id for job_id in self.completed_jobs if job_id not in jobs_to_keep]
                
                for job_id in jobs_to_remove:
                    del self.completed_jobs[job_id]
                    cache.delete(f"bg_job_{job_id}")
                
                logger.info(f"Cleaned up {len(jobs_to_remove)} old completed jobs")
    
    def get_queue_stats(self) -> Dict[str, Any]:
        """Get statistics about the background processing queue"""
        with self._lock:
            return {
                'queue_size': self.job_queue.qsize(),
                'active_jobs': len(self.active_jobs),
                'completed_jobs': len(self.completed_jobs),
                'workers': len(self.workers),
                'running': self.running
            }


# Global instance
_background_processor = None

def get_background_processor() -> BackgroundProcessor:
    """Get the global background processor instance"""
    global _background_processor
    if _background_processor is None:
        _background_processor = BackgroundProcessor()
        # Auto-start the processor
        _background_processor.start()
    return _background_processor


def queue_ai_operation(service_name: str, function_name: str, *args,
                      priority: JobPriority = JobPriority.NORMAL,
                      timeout_seconds: int = 300,
                      user_id: Optional[str] = None,
                      **kwargs) -> str:
    """Convenience function to queue an AI operation"""
    processor = get_background_processor()
    return processor.queue_job(
        service_name=service_name,
        function_name=function_name,
        args=args,
        priority=priority,
        timeout_seconds=timeout_seconds,
        user_id=user_id,
        **kwargs
    )


def get_job_status(job_id: str) -> Optional[BackgroundJob]:
    """Convenience function to get job status"""
    processor = get_background_processor()
    return processor.get_job_status(job_id)