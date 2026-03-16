# AI Service Failure Handling System

## Overview

The AI Service Failure Handling System provides comprehensive error handling, graceful degradation, and manual override options for all AI-powered features in the Product Editor. This system ensures users can continue working even when AI services are unavailable or experiencing issues.

## Key Features

### 1. Graceful Degradation
- **Automatic Fallbacks**: When AI services fail, the system automatically provides alternative processing methods
- **Simplified AI Processing**: Falls back to basic algorithms when advanced AI models are unavailable
- **Manual Processing Options**: Always provides manual tools as alternatives to AI features

### 2. Timeout Handling
- **Configurable Timeouts**: Each AI service has appropriate timeout limits
- **Background Processing**: Long-running operations can be queued for background processing
- **Progress Tracking**: Real-time progress updates for background operations

### 3. Circuit Breaker Pattern
- **Failure Threshold**: Automatically disables services after repeated failures
- **Auto-Recovery**: Services are re-enabled after a timeout period
- **Manual Reset**: Administrators can manually reset circuit breakers

### 4. Manual Override Options
- **Context-Aware Alternatives**: Provides relevant manual tools based on the failed operation
- **Step-by-Step Guidance**: Includes instructions for manual processing
- **Tutorial Links**: Links to help documentation and video tutorials

## Architecture

### Core Components

#### 1. AIServiceFailureHandler
- **Purpose**: Central coordinator for all failure handling logic
- **Location**: `ai_engine/failure_handler.py`
- **Key Methods**:
  - `with_failure_handling()`: Decorator for adding failure handling to AI methods
  - `_classify_error()`: Determines failure type from exceptions
  - `_determine_fallback_strategy()`: Selects appropriate fallback approach
  - `_execute_fallback()`: Implements the chosen fallback strategy

#### 2. BackgroundProcessor
- **Purpose**: Handles background processing and retry logic
- **Location**: `ai_engine/background_processor.py`
- **Features**:
  - Multi-threaded job processing
  - Exponential backoff retry mechanism
  - Job status tracking and progress reporting
  - Priority-based queue management

#### 3. Enhanced AI Services
All AI services have been enhanced with failure handling:
- **BackgroundRemovalService**: Enhanced with timeout handling and manual override options
- **ProductDetectionService**: Provides manual selection tools and detection suggestions
- **DesignPlacementService**: Falls back to simple scaling when perspective calculation fails
- **BlendEngine**: Uses basic opacity blending when advanced modes fail

## Failure Types and Strategies

### Failure Classification

| Failure Type | Description | Common Causes |
|--------------|-------------|---------------|
| `MODEL_UNAVAILABLE` | AI model cannot be loaded | Missing model files, GPU unavailable |
| `TIMEOUT` | Operation exceeds time limit | Large images, system overload |
| `PROCESSING_ERROR` | Error during AI processing | Corrupted input, algorithm failure |
| `RESOURCE_EXHAUSTED` | Insufficient system resources | Out of memory, CPU overload |
| `NETWORK_ERROR` | Network connectivity issues | API unavailable, connection timeout |
| `INVALID_INPUT` | Input data is invalid | Unsupported format, corrupted file |

### Fallback Strategies

| Strategy | When Used | Implementation |
|----------|-----------|----------------|
| `MANUAL_PROCESSING` | Model unavailable, invalid input | Provides manual tools and instructions |
| `SIMPLIFIED_AI` | Processing errors | Uses basic algorithms instead of AI |
| `QUEUE_FOR_RETRY` | Timeouts, resource exhaustion | Queues operation for background processing |
| `SKIP_FEATURE` | Non-critical features | Continues without the AI feature |
| `CACHED_RESULT` | Network errors | Uses previously cached results |

## API Integration

### Enhanced Error Responses

All AI API endpoints now return enhanced error information:

```json
{
  "success": false,
  "detail": "AI background removal is currently unavailable",
  "fallback_used": false,
  "manual_override_available": true,
  "suggested_actions": [
    "Use manual background removal tools",
    "Try again later when AI service is restored"
  ],
  "manual_override_options": {
    "available": true,
    "options": [
      {
        "name": "manual_selection",
        "display_name": "Manual Background Selection",
        "description": "Manually select background areas to remove",
        "tools_required": ["selection_tool", "eraser_tool"],
        "instructions": [
          "Use the selection tool to outline the background",
          "Apply the eraser tool to remove selected areas"
        ]
      }
    ],
    "tutorials": [
      {
        "title": "Manual Background Removal Guide",
        "url": "/help/manual-background-removal",
        "duration": "5 minutes"
      }
    ]
  }
}
```

### Background Processing

When operations are queued for background processing:

```json
{
  "success": false,
  "detail": "Processing queued for background execution",
  "background_job_id": "uuid-here",
  "manual_override_available": true,
  "suggested_actions": [
    "Continue with other tasks",
    "Check background job status",
    "Use manual tools if needed immediately"
  ]
}
```

### New API Endpoints

#### Service Status
- `GET /api/ai/status/` - Comprehensive AI service health status
- `GET /api/ai/manual-override-options/` - Available manual override options
- `GET /api/ai/manual-override-options/{service}/` - Service-specific options

#### Background Jobs
- `GET /api/ai/background-jobs/{job_id}/status/` - Background job status
- `GET /api/ai/jobs/` - List recent AI processing jobs
- `GET /api/ai/jobs/{job_id}/` - Detailed job information

#### Administration
- `POST /api/ai/circuit-breaker/{service}/reset/` - Reset circuit breaker (admin only)

## Frontend Integration

### AIFailureHandler Component

The React component provides user-friendly error handling:

```tsx
import { AIFailureHandler, useAIFailureHandler } from '@/components/AIFailureHandler';

const MyComponent = () => {
  const { error, handleAIError, clearError, retryOperation } = useAIFailureHandler();

  const processImage = async () => {
    try {
      const result = await retryOperation(() => 
        fetch('/api/ai/remove-background/', { /* ... */ })
      );
      // Handle success
    } catch (error) {
      handleAIError(error.response.data, 'Background Removal');
    }
  };

  return (
    <div>
      <AIFailureHandler
        error={error}
        onRetry={processImage}
        onManualOverride={(option) => {
          // Handle manual override selection
        }}
        onDismiss={clearError}
      />
      {/* Your component content */}
    </div>
  );
};
```

### Service Health Indicator

Display overall AI service health:

```tsx
import { AIServiceHealthIndicator } from '@/components/AIFailureHandler';

const Header = () => (
  <div className="header">
    <AIServiceHealthIndicator />
    {/* Other header content */}
  </div>
);
```

## Configuration

### Service Timeouts

Configure timeouts in `failure_handler.py`:

```python
self.service_timeouts = {
    'background_removal': 30,    # 30 seconds
    'product_detection': 10,     # 10 seconds
    'design_placement': 5,       # 5 seconds
    'blend_engine': 15,          # 15 seconds
    'complete_processing': 120   # 2 minutes
}
```

### Circuit Breaker Thresholds

Configure failure thresholds:

```python
self.circuit_breaker_thresholds = {
    'background_removal': 5,     # 5 failures before opening
    'product_detection': 5,      # 5 failures before opening
    'design_placement': 3,       # 3 failures before opening
    'blend_engine': 3            # 3 failures before opening
}
```

### Background Processing

Configure worker threads and queue settings:

```python
# In background_processor.py
processor = BackgroundProcessor(max_workers=3)  # 3 worker threads
```

## Monitoring and Logging

### Health Monitoring

The system provides comprehensive health monitoring:

- **Service Availability**: Real-time status of each AI service
- **Failure Rates**: Track failure counts and circuit breaker status
- **Performance Metrics**: Processing times and queue statistics
- **Resource Usage**: Memory and CPU utilization

### Logging

All failures are logged with appropriate detail:

```python
logger.error(f"AI service failure - {service_name}: {error_message}")
logger.warning(f"Circuit breaker opened for {service_name}")
logger.info(f"Fallback strategy applied: {strategy} for {service_name}")
```

## Testing

### Unit Tests

Comprehensive test coverage in `tests/test_ai_failure_handling.py`:

- Failure classification accuracy
- Fallback strategy selection
- Circuit breaker functionality
- Background processing
- Manual override options
- Integration workflows

### Running Tests

```bash
python manage.py test tests.test_ai_failure_handling
```

## Best Practices

### For Developers

1. **Always Use Failure Handling**: Apply the `@with_failure_handling` decorator to all AI service methods
2. **Provide Clear Error Messages**: Include actionable information in error messages
3. **Test Failure Scenarios**: Regularly test with simulated failures
4. **Monitor Service Health**: Check service status before critical operations

### For Users

1. **Check Service Status**: Use the health indicator to see AI service availability
2. **Use Manual Overrides**: When AI fails, manual tools provide full functionality
3. **Enable Background Processing**: For large operations, use background processing
4. **Follow Tutorials**: Use provided tutorials for manual processing guidance

## Troubleshooting

### Common Issues

#### Circuit Breaker Stuck Open
- **Symptom**: Service shows as unavailable despite being functional
- **Solution**: Use admin reset endpoint or wait for timeout period
- **Prevention**: Monitor failure rates and address root causes

#### Background Jobs Not Processing
- **Symptom**: Jobs stuck in queued status
- **Solution**: Check worker thread status and restart background processor
- **Prevention**: Monitor queue statistics and scale workers as needed

#### High Failure Rates
- **Symptom**: Frequent AI service failures
- **Solution**: Check system resources, model availability, and input validation
- **Prevention**: Implement proper resource monitoring and input sanitization

### Debug Information

Enable debug logging for detailed failure information:

```python
import logging
logging.getLogger('ai_engine.failure_handler').setLevel(logging.DEBUG)
```

## Future Enhancements

### Planned Features

1. **Adaptive Timeouts**: Automatically adjust timeouts based on historical performance
2. **Load Balancing**: Distribute AI processing across multiple instances
3. **Predictive Failure Detection**: Use metrics to predict and prevent failures
4. **Enhanced Caching**: Cache AI results for faster fallback responses
5. **User Preferences**: Allow users to configure fallback preferences

### Integration Opportunities

1. **Metrics Dashboard**: Real-time monitoring dashboard for administrators
2. **Alert System**: Notifications for service degradation
3. **A/B Testing**: Compare AI vs manual processing outcomes
4. **Performance Analytics**: Track user satisfaction with fallback options

## Conclusion

The AI Service Failure Handling System ensures robust, user-friendly operation of AI features in the Product Editor. By providing graceful degradation, comprehensive error handling, and intuitive manual override options, users can maintain productivity even when AI services experience issues.

The system is designed to be:
- **Resilient**: Handles all types of failures gracefully
- **User-Friendly**: Provides clear guidance and alternatives
- **Maintainable**: Well-structured code with comprehensive testing
- **Scalable**: Supports background processing and load distribution
- **Monitorable**: Comprehensive logging and health reporting

This implementation satisfies all requirements for AI service failure handling while providing a foundation for future enhancements and optimizations.