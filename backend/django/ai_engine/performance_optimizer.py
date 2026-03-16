"""
Performance Optimizer for AI Image Processing
Profiles performance, optimizes memory usage, and fine-tunes caching strategies
"""
import os
import time
import logging
import psutil
import threading
from typing import Dict, Any, List, Tuple, Optional
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import statistics
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)


@dataclass
class PerformanceMetrics:
    """Performance metrics for AI operations"""
    operation_name: str
    execution_time: float
    memory_usage_mb: float
    cpu_usage_percent: float
    gpu_usage_percent: Optional[float]
    cache_hit_rate: float
    throughput_ops_per_second: float
    error_rate: float
    timestamp: datetime = field(default_factory=datetime.now)


@dataclass
class OptimizationResult:
    """Result of performance optimization"""
    optimization_type: str
    before_metrics: PerformanceMetrics
    after_metrics: PerformanceMetrics
    improvement_percent: float
    recommendations: List[str]


class PerformanceProfiler:
    """Profiles AI processing performance and identifies bottlenecks"""
    
    def __init__(self):
        self.metrics_history: List[PerformanceMetrics] = []
        self.profiling_active = False
        self._lock = threading.Lock()
        
        # GPU monitoring (if available)
        self.gpu_available = self._check_gpu_availability()
        
        logger.info(f"Performance Profiler initialized (GPU available: {self.gpu_available})")
    
    def _check_gpu_availability(self) -> bool:
        """Check if GPU monitoring is available"""
        try:
            import GPUtil
            gpus = GPUtil.getGPUs()
            return len(gpus) > 0
        except ImportError:
            return False
    
    def start_profiling(self):
        """Start performance profiling"""
        self.profiling_active = True
        logger.info("Performance profiling started")
    
    def stop_profiling(self):
        """Stop performance profiling"""
        self.profiling_active = False
        logger.info("Performance profiling stopped")
    
    def profile_operation(self, operation_name: str, operation_func, *args, **kwargs):
        """Profile a single AI operation"""
        if not self.profiling_active:
            return operation_func(*args, **kwargs)
        
        # Measure before operation
        start_time = time.time()
        start_memory = psutil.virtual_memory().used / (1024 * 1024)
        start_cpu = psutil.cpu_percent()
        
        gpu_usage = None
        if self.gpu_available:
            gpu_usage = self._get_gpu_usage()
        
        # Execute operation
        try:
            result = operation_func(*args, **kwargs)
            error_occurred = False
        except Exception as e:
            logger.error(f"Operation {operation_name} failed: {e}")
            error_occurred = True
            raise
        finally:
            # Measure after operation
            end_time = time.time()
            end_memory = psutil.virtual_memory().used / (1024 * 1024)
            end_cpu = psutil.cpu_percent()
            
            execution_time = end_time - start_time
            memory_usage = end_memory - start_memory
            cpu_usage = (start_cpu + end_cpu) / 2
            
            if self.gpu_available:
                gpu_usage = self._get_gpu_usage()
            
            # Get cache hit rate
            cache_hit_rate = self._get_cache_hit_rate()
            
            # Calculate throughput (operations per second)
            throughput = 1.0 / execution_time if execution_time > 0 else 0
            
            # Record metrics
            metrics = PerformanceMetrics(
                operation_name=operation_name,
                execution_time=execution_time,
                memory_usage_mb=memory_usage,
                cpu_usage_percent=cpu_usage,
                gpu_usage_percent=gpu_usage,
                cache_hit_rate=cache_hit_rate,
                throughput_ops_per_second=throughput,
                error_rate=1.0 if error_occurred else 0.0
            )
            
            with self._lock:
                self.metrics_history.append(metrics)
                
                # Keep only recent metrics (last 1000 operations)
                if len(self.metrics_history) > 1000:
                    self.metrics_history = self.metrics_history[-1000:]
            
            logger.info(f"Profiled {operation_name}: {execution_time:.2f}s, "
                       f"{memory_usage:.1f}MB, {cpu_usage:.1f}% CPU")
        
        return result
    
    def _get_gpu_usage(self) -> Optional[float]:
        """Get current GPU usage percentage"""
        if not self.gpu_available:
            return None
        
        try:
            import GPUtil
            gpus = GPUtil.getGPUs()
            if gpus:
                return gpus[0].load * 100  # Convert to percentage
        except Exception:
            pass
        
        return None
    
    def _get_cache_hit_rate(self) -> float:
        """Get current cache hit rate"""
        try:
            from .resource_manager import get_resource_manager
            resource_manager = get_resource_manager()
            return resource_manager.result_cache.get_hit_rate()
        except Exception:
            return 0.0
    
    def get_performance_summary(self, operation_name: Optional[str] = None) -> Dict[str, Any]:
        """Get performance summary for analysis"""
        with self._lock:
            if operation_name:
                relevant_metrics = [m for m in self.metrics_history if m.operation_name == operation_name]
            else:
                relevant_metrics = self.metrics_history
        
        if not relevant_metrics:
            return {"error": "No metrics available"}
        
        # Calculate statistics
        execution_times = [m.execution_time for m in relevant_metrics]
        memory_usages = [m.memory_usage_mb for m in relevant_metrics]
        cpu_usages = [m.cpu_usage_percent for m in relevant_metrics]
        throughputs = [m.throughput_ops_per_second for m in relevant_metrics]
        error_rates = [m.error_rate for m in relevant_metrics]
        
        return {
            "operation_name": operation_name or "all_operations",
            "total_operations": len(relevant_metrics),
            "time_range": {
                "start": min(m.timestamp for m in relevant_metrics).isoformat(),
                "end": max(m.timestamp for m in relevant_metrics).isoformat()
            },
            "execution_time": {
                "mean": statistics.mean(execution_times),
                "median": statistics.median(execution_times),
                "min": min(execution_times),
                "max": max(execution_times),
                "std_dev": statistics.stdev(execution_times) if len(execution_times) > 1 else 0
            },
            "memory_usage_mb": {
                "mean": statistics.mean(memory_usages),
                "median": statistics.median(memory_usages),
                "min": min(memory_usages),
                "max": max(memory_usages)
            },
            "cpu_usage_percent": {
                "mean": statistics.mean(cpu_usages),
                "median": statistics.median(cpu_usages),
                "min": min(cpu_usages),
                "max": max(cpu_usages)
            },
            "throughput_ops_per_second": {
                "mean": statistics.mean(throughputs),
                "median": statistics.median(throughputs),
                "min": min(throughputs),
                "max": max(throughputs)
            },
            "error_rate": statistics.mean(error_rates),
            "cache_hit_rate": statistics.mean([m.cache_hit_rate for m in relevant_metrics])
        }


class CacheOptimizer:
    """Optimizes caching strategies for better performance"""
    
    def __init__(self):
        self.optimization_history: List[OptimizationResult] = []
        logger.info("Cache Optimizer initialized")
    
    def analyze_cache_performance(self) -> Dict[str, Any]:
        """Analyze current cache performance"""
        try:
            from .resource_manager import get_resource_manager
            resource_manager = get_resource_manager()
            cache_stats = resource_manager.result_cache.get_stats()
            
            # Get cache backend info
            cache_info = {
                'backend': str(cache._cache.__class__.__name__),
                'location': getattr(cache._cache, '_cache', {}).get('LOCATION', 'default')
            }
            
            analysis = {
                'current_stats': cache_stats,
                'cache_info': cache_info,
                'recommendations': []
            }
            
            # Analyze hit rate
            hit_rate = cache_stats.get('hit_rate', 0)
            if hit_rate < 0.3:
                analysis['recommendations'].append(
                    "Low cache hit rate (<30%). Consider increasing cache TTL or improving cache key strategy."
                )
            elif hit_rate > 0.8:
                analysis['recommendations'].append(
                    "Excellent cache hit rate (>80%). Current caching strategy is effective."
                )
            
            # Analyze cache size and memory usage
            total_requests = cache_stats.get('total_requests', 0)
            if total_requests > 1000:
                analysis['recommendations'].append(
                    "High cache usage detected. Consider implementing cache partitioning or LRU eviction."
                )
            
            return analysis
            
        except Exception as e:
            logger.error(f"Cache analysis failed: {e}")
            return {"error": str(e)}
    
    def optimize_cache_ttl(self, operation_patterns: Dict[str, List[float]]) -> OptimizationResult:
        """Optimize cache TTL based on operation patterns"""
        # Analyze operation frequency patterns
        recommendations = []
        
        for operation, access_times in operation_patterns.items():
            if len(access_times) < 2:
                continue
            
            # Calculate time between accesses
            intervals = []
            for i in range(1, len(access_times)):
                intervals.append(access_times[i] - access_times[i-1])
            
            if intervals:
                avg_interval = statistics.mean(intervals)
                median_interval = statistics.median(intervals)
                
                # Recommend TTL based on access patterns
                if avg_interval < 300:  # 5 minutes
                    recommended_ttl = 600  # 10 minutes
                    recommendations.append(f"{operation}: High frequency access, TTL=10min")
                elif avg_interval < 3600:  # 1 hour
                    recommended_ttl = 7200  # 2 hours
                    recommendations.append(f"{operation}: Medium frequency access, TTL=2h")
                else:
                    recommended_ttl = 3600  # 1 hour
                    recommendations.append(f"{operation}: Low frequency access, TTL=1h")
        
        return OptimizationResult(
            optimization_type="cache_ttl",
            before_metrics=None,  # Would need baseline metrics
            after_metrics=None,   # Would need post-optimization metrics
            improvement_percent=0,  # Would calculate after implementation
            recommendations=recommendations
        )
    
    def implement_cache_warming(self, critical_operations: List[str]) -> bool:
        """Implement cache warming for critical operations"""
        try:
            from .resource_manager import get_resource_manager
            resource_manager = get_resource_manager()
            
            # Pre-load cache with common operation results
            for operation in critical_operations:
                # This would pre-compute and cache common results
                logger.info(f"Warming cache for operation: {operation}")
                # Implementation would depend on specific operation types
            
            logger.info(f"Cache warming completed for {len(critical_operations)} operations")
            return True
            
        except Exception as e:
            logger.error(f"Cache warming failed: {e}")
            return False


class MemoryOptimizer:
    """Optimizes memory usage for concurrent AI operations"""
    
    def __init__(self):
        self.memory_snapshots: List[Tuple[datetime, float]] = []
        self.optimization_active = False
        logger.info("Memory Optimizer initialized")
    
    def start_memory_monitoring(self):
        """Start continuous memory monitoring"""
        self.optimization_active = True
        
        def monitor_loop():
            while self.optimization_active:
                memory_usage = psutil.virtual_memory().percent
                self.memory_snapshots.append((datetime.now(), memory_usage))
                
                # Keep only last hour of data
                cutoff_time = datetime.now() - timedelta(hours=1)
                self.memory_snapshots = [
                    (timestamp, usage) for timestamp, usage in self.memory_snapshots
                    if timestamp > cutoff_time
                ]
                
                time.sleep(30)  # Check every 30 seconds
        
        monitor_thread = threading.Thread(target=monitor_loop, daemon=True)
        monitor_thread.start()
        logger.info("Memory monitoring started")
    
    def stop_memory_monitoring(self):
        """Stop memory monitoring"""
        self.optimization_active = False
        logger.info("Memory monitoring stopped")
    
    def analyze_memory_patterns(self) -> Dict[str, Any]:
        """Analyze memory usage patterns"""
        if not self.memory_snapshots:
            return {"error": "No memory data available"}
        
        memory_values = [usage for _, usage in self.memory_snapshots]
        
        analysis = {
            "current_usage": psutil.virtual_memory().percent,
            "average_usage": statistics.mean(memory_values),
            "peak_usage": max(memory_values),
            "min_usage": min(memory_values),
            "usage_variance": statistics.variance(memory_values) if len(memory_values) > 1 else 0,
            "recommendations": []
        }
        
        # Generate recommendations
        if analysis["peak_usage"] > 90:
            analysis["recommendations"].append(
                "Critical: Peak memory usage >90%. Implement aggressive memory optimization."
            )
        elif analysis["peak_usage"] > 80:
            analysis["recommendations"].append(
                "Warning: Peak memory usage >80%. Consider memory optimization."
            )
        
        if analysis["usage_variance"] > 100:
            analysis["recommendations"].append(
                "High memory usage variance detected. Implement memory pooling or batch processing."
            )
        
        return analysis
    
    def optimize_concurrent_processing(self, max_concurrent: int) -> Dict[str, Any]:
        """Optimize concurrent processing limits based on available memory"""
        available_memory_gb = psutil.virtual_memory().available / (1024**3)
        
        # Estimate memory per AI operation (rough estimates)
        memory_per_operation = {
            'background_removal': 0.5,  # GB
            'product_detection': 0.3,   # GB
            'design_placement': 0.2,    # GB
            'blend_engine': 0.4         # GB
        }
        
        recommendations = {}
        
        for operation, memory_gb in memory_per_operation.items():
            safe_concurrent = int(available_memory_gb * 0.7 / memory_gb)  # Use 70% of available memory
            recommended = min(safe_concurrent, max_concurrent)
            
            recommendations[operation] = {
                'current_limit': max_concurrent,
                'recommended_limit': recommended,
                'memory_per_operation_gb': memory_gb,
                'reason': f"Based on {available_memory_gb:.1f}GB available memory"
            }
        
        return {
            'available_memory_gb': available_memory_gb,
            'recommendations': recommendations,
            'overall_recommendation': min(r['recommended_limit'] for r in recommendations.values())
        }


class GPUOptimizer:
    """Optimizes GPU usage for AI operations"""
    
    def __init__(self):
        self.gpu_available = self._check_gpu_availability()
        logger.info(f"GPU Optimizer initialized (GPU available: {self.gpu_available})")
    
    def _check_gpu_availability(self) -> bool:
        """Check if GPU is available for optimization"""
        try:
            import torch
            return torch.cuda.is_available()
        except ImportError:
            return False
    
    def validate_gpu_acceleration(self) -> Dict[str, Any]:
        """Validate GPU acceleration effectiveness"""
        if not self.gpu_available:
            return {
                "gpu_available": False,
                "recommendation": "Install CUDA and PyTorch with GPU support for acceleration"
            }
        
        try:
            import torch
            
            # Test GPU performance vs CPU
            device_info = {
                "gpu_available": True,
                "gpu_count": torch.cuda.device_count(),
                "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else None,
                "cuda_version": torch.version.cuda,
                "memory_allocated_gb": torch.cuda.memory_allocated(0) / (1024**3) if torch.cuda.device_count() > 0 else 0,
                "memory_reserved_gb": torch.cuda.memory_reserved(0) / (1024**3) if torch.cuda.device_count() > 0 else 0
            }
            
            # Simple performance test
            if torch.cuda.device_count() > 0:
                # Test tensor operations on GPU vs CPU
                size = 1000
                cpu_tensor = torch.randn(size, size)
                gpu_tensor = cpu_tensor.cuda()
                
                # Time CPU operation
                start_time = time.time()
                cpu_result = torch.mm(cpu_tensor, cpu_tensor)
                cpu_time = time.time() - start_time
                
                # Time GPU operation
                torch.cuda.synchronize()
                start_time = time.time()
                gpu_result = torch.mm(gpu_tensor, gpu_tensor)
                torch.cuda.synchronize()
                gpu_time = time.time() - start_time
                
                speedup = cpu_time / gpu_time if gpu_time > 0 else 0
                
                device_info.update({
                    "performance_test": {
                        "cpu_time_seconds": cpu_time,
                        "gpu_time_seconds": gpu_time,
                        "speedup_factor": speedup
                    },
                    "recommendation": f"GPU is {speedup:.1f}x faster than CPU" if speedup > 1 else "GPU performance is suboptimal"
                })
            
            return device_info
            
        except Exception as e:
            return {
                "gpu_available": False,
                "error": str(e),
                "recommendation": "GPU validation failed. Check CUDA installation."
            }
    
    def optimize_gpu_memory(self) -> Dict[str, Any]:
        """Optimize GPU memory usage"""
        if not self.gpu_available:
            return {"error": "GPU not available"}
        
        try:
            import torch
            
            if torch.cuda.device_count() == 0:
                return {"error": "No CUDA devices available"}
            
            # Clear GPU cache
            torch.cuda.empty_cache()
            
            # Get memory info
            memory_info = {
                "total_memory_gb": torch.cuda.get_device_properties(0).total_memory / (1024**3),
                "allocated_memory_gb": torch.cuda.memory_allocated(0) / (1024**3),
                "reserved_memory_gb": torch.cuda.memory_reserved(0) / (1024**3),
                "free_memory_gb": (torch.cuda.get_device_properties(0).total_memory - torch.cuda.memory_reserved(0)) / (1024**3)
            }
            
            recommendations = []
            
            utilization = memory_info["reserved_memory_gb"] / memory_info["total_memory_gb"]
            if utilization > 0.9:
                recommendations.append("High GPU memory usage (>90%). Consider batch size reduction.")
            elif utilization < 0.3:
                recommendations.append("Low GPU memory usage (<30%). Consider increasing batch size.")
            
            memory_info["recommendations"] = recommendations
            return memory_info
            
        except Exception as e:
            return {"error": str(e)}


class PerformanceOptimizer:
    """Main performance optimizer that coordinates all optimization strategies"""
    
    def __init__(self):
        self.profiler = PerformanceProfiler()
        self.cache_optimizer = CacheOptimizer()
        self.memory_optimizer = MemoryOptimizer()
        self.gpu_optimizer = GPUOptimizer()
        
        logger.info("Performance Optimizer initialized")
    
    def run_comprehensive_optimization(self) -> Dict[str, Any]:
        """Run comprehensive performance optimization"""
        results = {
            "timestamp": datetime.now().isoformat(),
            "optimizations": {}
        }
        
        # 1. Analyze cache performance
        logger.info("Analyzing cache performance...")
        cache_analysis = self.cache_optimizer.analyze_cache_performance()
        results["optimizations"]["cache"] = cache_analysis
        
        # 2. Analyze memory patterns
        logger.info("Analyzing memory patterns...")
        memory_analysis = self.memory_optimizer.analyze_memory_patterns()
        results["optimizations"]["memory"] = memory_analysis
        
        # 3. Validate GPU acceleration
        logger.info("Validating GPU acceleration...")
        gpu_analysis = self.gpu_optimizer.validate_gpu_acceleration()
        results["optimizations"]["gpu"] = gpu_analysis
        
        # 4. Get performance summary
        logger.info("Generating performance summary...")
        performance_summary = self.profiler.get_performance_summary()
        results["performance_summary"] = performance_summary
        
        # 5. Generate overall recommendations
        overall_recommendations = self._generate_overall_recommendations(results)
        results["overall_recommendations"] = overall_recommendations
        
        logger.info("Comprehensive optimization analysis completed")
        return results
    
    def _generate_overall_recommendations(self, analysis_results: Dict[str, Any]) -> List[str]:
        """Generate overall optimization recommendations"""
        recommendations = []
        
        # Cache recommendations
        cache_hit_rate = analysis_results.get("performance_summary", {}).get("cache_hit_rate", 0)
        if cache_hit_rate < 0.5:
            recommendations.append("Implement cache warming and optimize TTL settings for better cache performance")
        
        # Memory recommendations
        memory_analysis = analysis_results.get("optimizations", {}).get("memory", {})
        if memory_analysis.get("peak_usage", 0) > 80:
            recommendations.append("Implement memory optimization and reduce concurrent processing limits")
        
        # GPU recommendations
        gpu_analysis = analysis_results.get("optimizations", {}).get("gpu", {})
        if not gpu_analysis.get("gpu_available", False):
            recommendations.append("Consider GPU acceleration for significant performance improvements")
        elif gpu_analysis.get("performance_test", {}).get("speedup_factor", 0) < 2:
            recommendations.append("GPU acceleration is suboptimal. Check CUDA configuration and model optimization")
        
        # Performance recommendations
        perf_summary = analysis_results.get("performance_summary", {})
        error_rate = perf_summary.get("error_rate", 0)
        if error_rate > 0.05:  # 5% error rate
            recommendations.append("High error rate detected. Implement better error handling and retry mechanisms")
        
        avg_execution_time = perf_summary.get("execution_time", {}).get("mean", 0)
        if avg_execution_time > 10:  # 10 seconds
            recommendations.append("Long execution times detected. Consider model optimization and parallel processing")
        
        if not recommendations:
            recommendations.append("System performance is optimal. Continue monitoring for any degradation")
        
        return recommendations
    
    def start_continuous_optimization(self):
        """Start continuous performance monitoring and optimization"""
        self.profiler.start_profiling()
        self.memory_optimizer.start_memory_monitoring()
        logger.info("Continuous performance optimization started")
    
    def stop_continuous_optimization(self):
        """Stop continuous performance monitoring"""
        self.profiler.stop_profiling()
        self.memory_optimizer.stop_memory_monitoring()
        logger.info("Continuous performance optimization stopped")


# Global instance
_performance_optimizer = None

def get_performance_optimizer() -> PerformanceOptimizer:
    """Get the global performance optimizer instance"""
    global _performance_optimizer
    if _performance_optimizer is None:
        _performance_optimizer = PerformanceOptimizer()
    return _performance_optimizer