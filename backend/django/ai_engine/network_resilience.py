"""
Network Resilience and Request Queuing for AI Services
Handles network failures, request queuing, and retry mechanisms
"""
import logging
import time
import threading
from typing import Dict, Any, Optional, List, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
import queue
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)


class NetworkStatus(Enum):
    """Network connectivity status"""
    ONLINE = "online"
    DEGRADED = "degraded"
    OFFLINE = "offline"


@dataclass
class QueuedRequest:
    """Represents a queued network request"""
    id: str
    url: str
    method: str
    data: Any
    headers: Dict[str, str]
    timeout: int
    max_retries: int
    retry_count: int = 0
    created_at: datetime = field(default_factory=datetime.now)
    last_attempt: Optional[datetime] = None
    callback: Optional[Callable] = None
    user_id: Optional[str] = None


class NetworkHealthMonitor:
    """Monitors network connectivity and service availability"""
    
    def __init__(self, check_interval: int = 30):
        self.check_interval = check_interval
        self.status = NetworkStatus.ONLINE
        self.last_check = datetime.now()
        self.consecutive_failures = 0
        self.service_endpoints = {
            'huggingface': 'https://huggingface.co/api/health',
            'general': 'https://httpbin.org/status/200'
        }
        self._monitoring = False
        self._monitor_thread = None
        
        logger.info("Network health monitor initialized")
    
    def start_monitoring(self):
        """Start continuous network monitoring"""
        if self._monitoring:
            return
        
        self._monitoring = True
        self._monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._monitor_thread.start()
        logger.info("Network monitoring started")
    
    def stop_monitoring(self):
        """Stop network monitoring"""
        self._monitoring = False
        if self._monitor_thread:
            self._monitor_thread.join(timeout=5)
        logger.info("Network monitoring stopped")
    
    def _monitor_loop(self):
        """Main monitoring loop"""
        while self._monitoring:
            try:
                self._check_connectivity()
                time.sleep(self.check_interval)
            except Exception as e:
                logger.error(f"Network monitoring error: {e}")
                time.sleep(self.check_interval)
    
    def _check_connectivity(self):
        """Check network connectivity to key services"""
        try:
            # Quick connectivity check
            response = requests.get(
                self.service_endpoints['general'],
                timeout=5,
                headers={'User-Agent': 'AI-Service-Health-Check/1.0'}
            )
            
            if response.status_code == 200:
                if self.status != NetworkStatus.ONLINE:
                    logger.info("Network connectivity restored")
                self.status = NetworkStatus.ONLINE
                self.consecutive_failures = 0
            else:
                self._handle_connectivity_failure()
                
        except requests.exceptions.RequestException as e:
            logger.warning(f"Network connectivity check failed: {e}")
            self._handle_connectivity_failure()
        
        self.last_check = datetime.now()
    
    def _handle_connectivity_failure(self):
        """Handle network connectivity failure"""
        self.consecutive_failures += 1
        
        if self.consecutive_failures >= 3:
            if self.status != NetworkStatus.OFFLINE:
                logger.error("Network appears to be offline")
            self.status = NetworkStatus.OFFLINE
        elif self.consecutive_failures >= 1:
            if self.status != NetworkStatus.DEGRADED:
                logger.warning("Network connectivity degraded")
            self.status = NetworkStatus.DEGRADED
    
    def is_online(self) -> bool:
        """Check if network is considered online"""
        return self.status == NetworkStatus.ONLINE
    
    def is_degraded(self) -> bool:
        """Check if network is degraded"""
        return self.status == NetworkStatus.DEGRADED
    
    def get_status(self) -> Dict[str, Any]:
        """Get network status information"""
        return {
            'status': self.status.value,
            'last_check': self.last_check.isoformat(),
            'consecutive_failures': self.consecutive_failures,
            'uptime_check': (datetime.now() - self.last_check).total_seconds() < self.check_interval * 2
        }


class RequestQueue:
    """Queues network requests for retry when connectivity is poor"""
    
    def __init__(self, max_queue_size: int = 100):
        self.max_queue_size = max_queue_size
        self.request_queue = queue.PriorityQueue()
        self.failed_requests: Dict[str, QueuedRequest] = {}
        self.processing = False
        self._lock = threading.Lock()
        self._processor_thread = None
        
        logger.info(f"Request queue initialized with max size {max_queue_size}")
    
    def start_processing(self):
        """Start processing queued requests"""
        if self.processing:
            return
        
        self.processing = True
        self._processor_thread = threading.Thread(target=self._process_queue, daemon=True)
        self._processor_thread.start()
        logger.info("Request queue processing started")
    
    def stop_processing(self):
        """Stop processing queued requests"""
        self.processing = False
        if self._processor_thread:
            self._processor_thread.join(timeout=5)
        logger.info("Request queue processing stopped")
    
    def queue_request(self, request: QueuedRequest, priority: int = 1) -> bool:
        """Queue a request for later processing"""
        try:
            if self.request_queue.qsize() >= self.max_queue_size:
                logger.warning("Request queue is full, dropping oldest requests")
                self._drop_oldest_requests()
            
            # Priority: 0 = highest, higher numbers = lower priority
            self.request_queue.put((priority, request))
            
            with self._lock:
                self.failed_requests[request.id] = request
            
            logger.info(f"Queued request {request.id} with priority {priority}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to queue request: {e}")
            return False
    
    def _drop_oldest_requests(self):
        """Drop oldest requests to make room for new ones"""
        dropped_count = 0
        temp_requests = []
        
        # Extract all requests
        while not self.request_queue.empty():
            try:
                priority, request = self.request_queue.get_nowait()
                temp_requests.append((priority, request))
            except queue.Empty:
                break
        
        # Keep only the most recent 80% of requests
        keep_count = int(len(temp_requests) * 0.8)
        temp_requests.sort(key=lambda x: x[1].created_at, reverse=True)
        
        # Re-queue the kept requests
        for priority, request in temp_requests[:keep_count]:
            self.request_queue.put((priority, request))
        
        dropped_count = len(temp_requests) - keep_count
        if dropped_count > 0:
            logger.warning(f"Dropped {dropped_count} old requests from queue")
    
    def _process_queue(self):
        """Process queued requests"""
        while self.processing:
            try:
                # Get next request with timeout
                priority, request = self.request_queue.get(timeout=1)
                
                # Attempt to process the request
                success = self._attempt_request(request)
                
                if success:
                    with self._lock:
                        if request.id in self.failed_requests:
                            del self.failed_requests[request.id]
                    logger.info(f"Successfully processed queued request {request.id}")
                else:
                    # Re-queue if retries remaining
                    if request.retry_count < request.max_retries:
                        request.retry_count += 1
                        request.last_attempt = datetime.now()
                        
                        # Exponential backoff
                        delay = min(300, 2 ** request.retry_count * 5)  # Max 5 minutes
                        
                        # Re-queue with delay
                        threading.Timer(delay, lambda: self.request_queue.put((priority + 1, request))).start()
                        logger.info(f"Re-queued request {request.id} for retry {request.retry_count}/{request.max_retries}")
                    else:
                        logger.error(f"Request {request.id} failed permanently after {request.max_retries} retries")
                        with self._lock:
                            if request.id in self.failed_requests:
                                del self.failed_requests[request.id]
                
            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"Error processing request queue: {e}")
    
    def _attempt_request(self, request: QueuedRequest) -> bool:
        """Attempt to execute a queued request"""
        try:
            # Create session with retry strategy
            session = requests.Session()
            retry_strategy = Retry(
                total=0,  # We handle retries ourselves
                backoff_factor=1,
                status_forcelist=[429, 500, 502, 503, 504],
            )
            adapter = HTTPAdapter(max_retries=retry_strategy)
            session.mount("http://", adapter)
            session.mount("https://", adapter)
            
            # Execute request
            response = session.request(
                method=request.method,
                url=request.url,
                data=request.data,
                headers=request.headers,
                timeout=request.timeout
            )
            
            # Check if successful
            if response.status_code < 400:
                # Call callback if provided
                if request.callback:
                    try:
                        request.callback(response)
                    except Exception as e:
                        logger.warning(f"Request callback failed: {e}")
                return True
            else:
                logger.warning(f"Request {request.id} failed with status {response.status_code}")
                return False
                
        except Exception as e:
            logger.warning(f"Request {request.id} failed: {e}")
            return False
    
    def get_queue_stats(self) -> Dict[str, Any]:
        """Get queue statistics"""
        with self._lock:
            return {
                'queue_size': self.request_queue.qsize(),
                'max_queue_size': self.max_queue_size,
                'failed_requests': len(self.failed_requests),
                'processing': self.processing
            }


class NetworkResilientClient:
    """HTTP client with network resilience and automatic queuing"""
    
    def __init__(self):
        self.health_monitor = NetworkHealthMonitor()
        self.request_queue = RequestQueue()
        self.session = self._create_session()
        
        # Start monitoring and processing
        self.health_monitor.start_monitoring()
        self.request_queue.start_processing()
        
        logger.info("Network resilient client initialized")
    
    def _create_session(self) -> requests.Session:
        """Create HTTP session with retry configuration"""
        session = requests.Session()
        
        # Configure retry strategy
        retry_strategy = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["HEAD", "GET", "OPTIONS", "POST"]
        )
        
        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        
        # Set default headers
        session.headers.update({
            'User-Agent': 'AI-Service-Client/1.0',
            'Accept': 'application/json',
            'Connection': 'keep-alive'
        })
        
        return session
    
    def request(self, method: str, url: str, data: Any = None, 
                headers: Dict[str, str] = None, timeout: int = 30,
                queue_on_failure: bool = True, user_id: Optional[str] = None,
                callback: Optional[Callable] = None) -> Optional[requests.Response]:
        """Make HTTP request with network resilience"""
        
        # Check network status
        if not self.health_monitor.is_online() and queue_on_failure:
            # Queue request for later processing
            queued_request = QueuedRequest(
                id=f"{method}_{url}_{int(time.time())}",
                url=url,
                method=method,
                data=data,
                headers=headers or {},
                timeout=timeout,
                max_retries=3,
                callback=callback,
                user_id=user_id
            )
            
            if self.request_queue.queue_request(queued_request):
                logger.info(f"Request queued due to network issues: {method} {url}")
                return None
        
        try:
            # Attempt immediate request
            response = self.session.request(
                method=method,
                url=url,
                data=data,
                headers=headers,
                timeout=timeout
            )
            
            return response
            
        except requests.exceptions.RequestException as e:
            logger.warning(f"Request failed: {method} {url} - {e}")
            
            # Queue for retry if enabled
            if queue_on_failure:
                queued_request = QueuedRequest(
                    id=f"{method}_{url}_{int(time.time())}",
                    url=url,
                    method=method,
                    data=data,
                    headers=headers or {},
                    timeout=timeout,
                    max_retries=3,
                    callback=callback,
                    user_id=user_id
                )
                
                self.request_queue.queue_request(queued_request, priority=2)
            
            return None
    
    def get(self, url: str, **kwargs) -> Optional[requests.Response]:
        """GET request with resilience"""
        return self.request('GET', url, **kwargs)
    
    def post(self, url: str, data: Any = None, **kwargs) -> Optional[requests.Response]:
        """POST request with resilience"""
        return self.request('POST', url, data=data, **kwargs)
    
    def get_status(self) -> Dict[str, Any]:
        """Get network resilience status"""
        return {
            'network_health': self.health_monitor.get_status(),
            'request_queue': self.request_queue.get_queue_stats()
        }
    
    def shutdown(self):
        """Shutdown the resilient client"""
        self.health_monitor.stop_monitoring()
        self.request_queue.stop_processing()
        self.session.close()
        logger.info("Network resilient client shutdown")


# Global instance
_resilient_client = None

def get_resilient_client() -> NetworkResilientClient:
    """Get the global network resilient client"""
    global _resilient_client
    if _resilient_client is None:
        _resilient_client = NetworkResilientClient()
    return _resilient_client