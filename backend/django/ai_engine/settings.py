"""
AI Engine Settings for Resource Management and Optimization
Configuration for concurrent request limiting, caching, and memory optimization
"""

# Concurrent Request Limiting
AI_MAX_CONCURRENT_REQUESTS = 5  # Maximum concurrent AI processing requests
AI_MAX_REQUESTS_PER_USER = 2    # Maximum requests per user simultaneously

# Result Caching
AI_CACHE_TTL = 3600             # Cache TTL in seconds (1 hour)
AI_CACHE_PREFIX = 'ai_result_'  # Cache key prefix

# Memory Optimization
AI_MAX_IMAGE_SIZE_MB = 50       # Maximum image size before optimization
AI_TARGET_IMAGE_SIZE_MB = 10    # Target size for optimized images
AI_CLEANUP_INTERVAL_HOURS = 24  # Cleanup interval for optimized images

# Network Resilience
AI_NETWORK_CHECK_INTERVAL = 30  # Network health check interval in seconds
AI_REQUEST_QUEUE_SIZE = 100     # Maximum queued requests
AI_REQUEST_TIMEOUT = 30         # Default request timeout in seconds
AI_MAX_RETRIES = 3              # Maximum retry attempts

# Background Processing
AI_BACKGROUND_WORKERS = 3       # Number of background worker threads
AI_JOB_TIMEOUT = 300           # Background job timeout in seconds
AI_JOB_CLEANUP_HOURS = 24      # Job cleanup interval

# Resource Monitoring
AI_RESOURCE_MONITORING = True   # Enable resource monitoring
AI_MAINTENANCE_INTERVAL = 3600  # Maintenance interval in seconds (1 hour)

# Performance Thresholds
AI_CPU_THRESHOLD = 80          # CPU usage threshold for warnings
AI_MEMORY_THRESHOLD = 85       # Memory usage threshold for warnings
AI_CACHE_HIT_RATE_MIN = 0.3    # Minimum acceptable cache hit rate

# Model Management
AI_MODEL_CACHE_SIZE = 3        # Maximum number of cached models
AI_MODEL_CLEANUP_HOURS = 24    # Model cleanup interval
AI_GPU_MEMORY_FRACTION = 0.8   # GPU memory fraction to use

# Failure Handling
AI_CIRCUIT_BREAKER_THRESHOLD = 5    # Failures before circuit opens
AI_CIRCUIT_BREAKER_TIMEOUT = 60     # Circuit breaker timeout in seconds
AI_FALLBACK_ENABLED = True          # Enable fallback strategies

# Development/Debug Settings
AI_DEBUG_LOGGING = False       # Enable debug logging for AI operations
AI_METRICS_COLLECTION = True   # Enable metrics collection
AI_PERFORMANCE_PROFILING = False  # Enable performance profiling