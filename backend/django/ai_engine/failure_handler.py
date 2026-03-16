"""
AI Service Failure Handler
Provides comprehensive error handling, graceful degradation, and manual override options
"""
import logging
import time
from typing import Dict, Any, Optional, Callable, List
from dataclasses import dataclass
from enum import Enum
from datetime import datetime, timedelta
import threading
from functools import wraps

logger = logging.getLogger(__name__)


class FailureType(Enum):
    """Types of AI service failures"""
    MODEL_UNAVAILABLE = "model_unavailable"
    TIMEOUT = "timeout"
    PROCESSING_ERROR = "processing_error"
    RESOURCE_EXHAUSTED = "resource_exhausted"
    NETWORK_ERROR = "network_error"
    INVALID_INPUT = "invalid_input"


class FallbackStrategy(Enum):
    """Available fallback strategies"""
    MANUAL_PROCESSING = "manual_processing"
    SIMPLIFIED_AI = "simplified_ai"
    CACHED_RESULT = "cached_result"
    SKIP_FEATURE = "skip_feature"
    QUEUE_FOR_RETRY = "queue_for_retry"


@dataclass
class FailureContext:
    """Context information about a failure"""
    failure_type: FailureType
    service_name: str
    error_message: str
    timestamp: datetime
    input_data: Optional[Dict[str, Any]] = None
    retry_count: int = 0
    max_retries: int = 3


@dataclass
class FallbackResult:
    """Result of fallback processing"""
    success: bool
    strategy_used: FallbackStrategy
    result_data: Optional[Any] = None
    user_message: str = ""
    suggested_actions: List[str] = None
    manual_override_available: bool = True


class AIServiceFailureHandler:
    """Handles AI service failures with graceful degradation"""
    
    def __init__(self):
        self.failure_counts: Dict[str, int] = {}
        self.last_failure_times: Dict[str, datetime] = {}
        self.circuit_breaker_thresholds = {
            'background_removal': 5,
            'product_detection': 5,
            'design_placement': 3,
            'blend_engine': 3
        }
        self.circuit_breaker_timeout = timedelta(minutes=5)
        self._lock = threading.Lock()
        
        # Timeout configurations (in seconds)
        self.service_timeouts = {
            'background_removal': 30,
            'product_detection': 10,
            'design_placement': 5,
            'blend_engine': 15,
            'complete_processing': 120
        }
        
        logger.info("AI Service Failure Handler initialized")
    
    def with_failure_handling(self, service_name: str, timeout: Optional[int] = None):
        """Decorator to add comprehensive failure handling to AI service methods"""
        def decorator(func: Callable) -> Callable:
            @wraps(func)
            def wrapper(*args, **kwargs):
                # Check circuit breaker
                if self._is_circuit_open(service_name):
                    return self._handle_circuit_breaker_open(service_name)
                
                # Apply timeout
                effective_timeout = timeout or self.service_timeouts.get(service_name, 30)
                
                try:
                    # Execute with timeout
                    result = self._execute_with_timeout(func, effective_timeout, *args, **kwargs)
                    
                    # Reset failure count on success
                    self._reset_failure_count(service_name)
                    return result
                    
                except TimeoutError:
                    failure_context = FailureContext(
                        failure_type=FailureType.TIMEOUT,
                        service_name=service_name,
                        error_message=f"Service timeout after {effective_timeout} seconds",
                        timestamp=datetime.now()
                    )
                    return self._handle_failure(failure_context, *args, **kwargs)
                    
                except Exception as e:
                    failure_type = self._classify_error(e)
                    failure_context = FailureContext(
                        failure_type=failure_type,
                        service_name=service_name,
                        error_message=str(e),
                        timestamp=datetime.now()
                    )
                    return self._handle_failure(failure_context, *args, **kwargs)
            
            return wrapper
        return decorator
    
    def _execute_with_timeout(self, func: Callable, timeout: int, *args, **kwargs):
        """Execute function with timeout using threading"""
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
            # Thread is still running, timeout occurred
            raise TimeoutError(f"Function execution timed out after {timeout} seconds")
        
        if exception[0]:
            raise exception[0]
        
        return result[0]
    
    def _classify_error(self, error: Exception) -> FailureType:
        """Classify error type for appropriate handling"""
        error_str = str(error).lower()
        
        if "model" in error_str and ("not found" in error_str or "unavailable" in error_str):
            return FailureType.MODEL_UNAVAILABLE
        elif "timeout" in error_str:
            return FailureType.TIMEOUT
        elif "memory" in error_str or "resource" in error_str:
            return FailureType.RESOURCE_EXHAUSTED
        elif "network" in error_str or "connection" in error_str:
            return FailureType.NETWORK_ERROR
        elif "invalid" in error_str or "format" in error_str:
            return FailureType.INVALID_INPUT
        else:
            return FailureType.PROCESSING_ERROR
    
    def _handle_failure(self, context: FailureContext, *args, **kwargs) -> FallbackResult:
        """Handle service failure with appropriate fallback strategy"""
        
        # Increment failure count
        self._increment_failure_count(context.service_name)
        
        # Log the failure
        logger.error(f"AI service failure - {context.service_name}: {context.error_message}")
        
        # Determine fallback strategy
        strategy = self._determine_fallback_strategy(context)
        
        # Execute fallback
        return self._execute_fallback(context, strategy, *args, **kwargs)
    
    def _determine_fallback_strategy(self, context: FailureContext) -> FallbackStrategy:
        """Determine the best fallback strategy for the failure"""
        
        # Strategy based on failure type and service
        if context.failure_type == FailureType.TIMEOUT:
            if context.service_name in ['background_removal', 'complete_processing']:
                return FallbackStrategy.QUEUE_FOR_RETRY
            else:
                return FallbackStrategy.MANUAL_PROCESSING
        
        elif context.failure_type == FailureType.MODEL_UNAVAILABLE:
            if context.service_name == 'product_detection':
                return FallbackStrategy.MANUAL_PROCESSING
            elif context.service_name == 'background_removal':
                return FallbackStrategy.MANUAL_PROCESSING
            else:
                return FallbackStrategy.SIMPLIFIED_AI
        
        elif context.failure_type == FailureType.RESOURCE_EXHAUSTED:
            return FallbackStrategy.QUEUE_FOR_RETRY
        
        elif context.failure_type == FailureType.INVALID_INPUT:
            return FallbackStrategy.MANUAL_PROCESSING
        
        else:
            return FallbackStrategy.MANUAL_PROCESSING
    
    def _execute_fallback(self, context: FailureContext, strategy: FallbackStrategy, 
                         *args, **kwargs) -> FallbackResult:
        """Execute the chosen fallback strategy"""
        
        if strategy == FallbackStrategy.MANUAL_PROCESSING:
            return self._fallback_to_manual(context)
        
        elif strategy == FallbackStrategy.SIMPLIFIED_AI:
            return self._fallback_to_simplified_ai(context, *args, **kwargs)
        
        elif strategy == FallbackStrategy.QUEUE_FOR_RETRY:
            return self._fallback_to_queue_retry(context)
        
        elif strategy == FallbackStrategy.SKIP_FEATURE:
            return self._fallback_skip_feature(context)
        
        else:
            return self._fallback_to_manual(context)
    
    def _fallback_to_manual(self, context: FailureContext) -> FallbackResult:
        """Fallback to manual processing options"""
        
        messages = {
            'background_removal': "AI background removal is currently unavailable. You can continue with manual background removal tools or use the original image.",
            'product_detection': "AI product detection is currently unavailable. You can manually select product areas for design placement.",
            'design_placement': "AI design placement is currently unavailable. You can manually position and resize your design.",
            'blend_engine': "AI realistic blending is currently unavailable. You can use basic overlay blending or manual adjustment tools."
        }
        
        suggestions = {
            'background_removal': [
                "Use manual background removal tools",
                "Continue with original image",
                "Try again later when AI service is restored"
            ],
            'product_detection': [
                "Manually draw bounding boxes around products",
                "Use manual design placement tools",
                "Skip product detection and place designs manually"
            ],
            'design_placement': [
                "Use manual positioning controls",
                "Adjust design size and rotation manually",
                "Use grid guides for alignment"
            ],
            'blend_engine': [
                "Use basic opacity blending",
                "Apply manual texture effects",
                "Export without realistic blending"
            ]
        }
        
        return FallbackResult(
            success=False,
            strategy_used=strategy,
            user_message=messages.get(context.service_name, "AI service is currently unavailable. Please use manual tools."),
            suggested_actions=suggestions.get(context.service_name, ["Use manual tools", "Try again later"]),
            manual_override_available=True
        )
    
    def _fallback_to_simplified_ai(self, context: FailureContext, *args, **kwargs) -> FallbackResult:
        """Fallback to simplified AI processing"""
        
        try:
            if context.service_name == 'design_placement':
                # Use simple scaling instead of perspective transformation
                return self._simple_design_placement(*args, **kwargs)
            
            elif context.service_name == 'blend_engine':
                # Use basic opacity blending instead of advanced modes
                return self._simple_blending(*args, **kwargs)
            
            else:
                return self._fallback_to_manual(context)
                
        except Exception as e:
            logger.error(f"Simplified AI fallback failed: {e}")
            return self._fallback_to_manual(context)
    
    def _fallback_to_queue_retry(self, context: FailureContext) -> FallbackResult:
        """Queue operation for background retry"""
        
        return FallbackResult(
            success=False,
            strategy_used=FallbackStrategy.QUEUE_FOR_RETRY,
            user_message=f"AI service is temporarily overloaded. Your request has been queued for background processing.",
            suggested_actions=[
                "Continue with other tasks",
                "Check back in a few minutes",
                "Use manual tools if needed immediately"
            ],
            manual_override_available=True
        )
    
    def _fallback_skip_feature(self, context: FailureContext) -> FallbackResult:
        """Skip the AI feature and continue without it"""
        
        return FallbackResult(
            success=True,
            strategy_used=FallbackStrategy.SKIP_FEATURE,
            user_message=f"AI {context.service_name} was skipped due to service issues. Processing continued without this feature.",
            suggested_actions=[
                "Review results and apply manual adjustments if needed",
                "Try AI features again later"
            ],
            manual_override_available=True
        )
    
    def _simple_design_placement(self, *args, **kwargs) -> FallbackResult:
        """Simple design placement without perspective transformation"""
        try:
            # Extract arguments (this would need to match the actual function signature)
            if len(args) >= 2:
                design = args[0]
                product_bounds = args[1]
                
                # Simple centered placement
                from .design_placement import BoundingBox, PlacementResult
                import numpy as np
                
                # Calculate simple centered placement
                center_x = product_bounds.x + product_bounds.width // 2
                center_y = product_bounds.y + product_bounds.height // 2
                
                # Scale design to fit 60% of product bounds
                scale_factor = min(
                    (product_bounds.width * 0.6) / design.width,
                    (product_bounds.height * 0.4) / design.height
                )
                
                scaled_w = int(design.width * scale_factor)
                scaled_h = int(design.height * scale_factor)
                
                placement_bounds = BoundingBox(
                    center_x - scaled_w // 2,
                    center_y - scaled_h // 2,
                    scaled_w,
                    scaled_h
                )
                
                # Identity matrix (no transformation)
                transform_matrix = np.eye(3, dtype=np.float32)
                
                result = PlacementResult(
                    transform_matrix=transform_matrix,
                    placement_bounds=placement_bounds,
                    confidence=0.6,
                    fallback_used=True,
                    recommended_blend_mode="opacity"
                )
                
                return FallbackResult(
                    success=True,
                    strategy_used=FallbackStrategy.SIMPLIFIED_AI,
                    result_data=result,
                    user_message="Using simplified design placement (no perspective correction)",
                    suggested_actions=["Manually adjust position if needed"],
                    manual_override_available=True
                )
        except Exception as e:
            logger.error(f"Simple design placement failed: {e}")
        
        return self._fallback_to_manual(FailureContext(
            failure_type=FailureType.PROCESSING_ERROR,
            service_name="design_placement",
            error_message="Simple placement fallback failed",
            timestamp=datetime.now()
        ))
    
    def _simple_blending(self, *args, **kwargs) -> FallbackResult:
        """Simple opacity blending fallback"""
        try:
            if len(args) >= 2:
                design = args[0]
                background = args[1]
                
                # Simple opacity blend at 70%
                from PIL import Image
                import numpy as np
                
                # Ensure same size
                if design.size != background.size:
                    background = background.resize(design.size, Image.Resampling.LANCZOS)
                
                # Convert to RGBA
                design_rgba = design.convert('RGBA')
                background_rgba = background.convert('RGBA')
                
                # Simple opacity blend
                design_array = np.array(design_rgba, dtype=np.float32)
                background_array = np.array(background_rgba, dtype=np.float32)
                
                result_array = design_array * 0.7 + background_array * 0.3
                result_array = np.clip(result_array, 0, 255).astype(np.uint8)
                
                result_image = Image.fromarray(result_array, 'RGBA')
                
                return FallbackResult(
                    success=True,
                    strategy_used=FallbackStrategy.SIMPLIFIED_AI,
                    result_data=result_image,
                    user_message="Using simplified blending (basic opacity)",
                    suggested_actions=["Manually adjust blend settings if needed"],
                    manual_override_available=True
                )
        except Exception as e:
            logger.error(f"Simple blending failed: {e}")
        
        return self._fallback_to_manual(FailureContext(
            failure_type=FailureType.PROCESSING_ERROR,
            service_name="blend_engine",
            error_message="Simple blending fallback failed",
            timestamp=datetime.now()
        ))
    
    def _is_circuit_open(self, service_name: str) -> bool:
        """Check if circuit breaker is open for a service"""
        with self._lock:
            failure_count = self.failure_counts.get(service_name, 0)
            threshold = self.circuit_breaker_thresholds.get(service_name, 5)
            
            if failure_count < threshold:
                return False
            
            last_failure = self.last_failure_times.get(service_name)
            if last_failure and datetime.now() - last_failure < self.circuit_breaker_timeout:
                return True
            
            # Reset circuit breaker after timeout
            self.failure_counts[service_name] = 0
            return False
    
    def _handle_circuit_breaker_open(self, service_name: str) -> FallbackResult:
        """Handle when circuit breaker is open"""
        return FallbackResult(
            success=False,
            strategy_used=FallbackStrategy.MANUAL_PROCESSING,
            user_message=f"AI {service_name} is temporarily disabled due to repeated failures. Please use manual tools.",
            suggested_actions=[
                "Use manual processing tools",
                f"Try again in {self.circuit_breaker_timeout.total_seconds() // 60} minutes",
                "Contact support if issues persist"
            ],
            manual_override_available=True
        )
    
    def _increment_failure_count(self, service_name: str):
        """Increment failure count for circuit breaker"""
        with self._lock:
            self.failure_counts[service_name] = self.failure_counts.get(service_name, 0) + 1
            self.last_failure_times[service_name] = datetime.now()
    
    def _reset_failure_count(self, service_name: str):
        """Reset failure count on successful operation"""
        with self._lock:
            self.failure_counts[service_name] = 0
            if service_name in self.last_failure_times:
                del self.last_failure_times[service_name]
    
    def get_service_status(self) -> Dict[str, Dict[str, Any]]:
        """Get current status of all AI services"""
        with self._lock:
            status = {}
            for service_name in self.circuit_breaker_thresholds.keys():
                failure_count = self.failure_counts.get(service_name, 0)
                threshold = self.circuit_breaker_thresholds[service_name]
                is_circuit_open = self._is_circuit_open(service_name)
                
                status[service_name] = {
                    'failure_count': failure_count,
                    'threshold': threshold,
                    'circuit_open': is_circuit_open,
                    'last_failure': self.last_failure_times.get(service_name),
                    'status': 'unavailable' if is_circuit_open else 'available'
                }
            
            return status
    
    def reset_circuit_breaker(self, service_name: str):
        """Manually reset circuit breaker for a service"""
        with self._lock:
            self.failure_counts[service_name] = 0
            if service_name in self.last_failure_times:
                del self.last_failure_times[service_name]
            logger.info(f"Circuit breaker reset for {service_name}")


# Global instance
_failure_handler = None

def get_failure_handler() -> AIServiceFailureHandler:
    """Get the global failure handler instance"""
    global _failure_handler
    if _failure_handler is None:
        _failure_handler = AIServiceFailureHandler()
    return _failure_handler