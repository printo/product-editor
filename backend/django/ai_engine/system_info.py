"""
System Information Utility for AI Processing
Auto-detects system resources and provides configuration recommendations
"""
import os
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


def get_system_info() -> Dict[str, Any]:
    """Get comprehensive system information for AI processing optimization"""
    try:
        import psutil
        import torch
        
        # CPU information
        cpu_count = psutil.cpu_count(logical=True)
        try:
            cpu_freq = psutil.cpu_freq()
        except Exception as e:
            logger.warning(f"Error getting CPU frequency: {e}")
            cpu_freq = None
        
        # Memory information
        memory = psutil.virtual_memory()
        memory_gb = memory.total / (1024**3)
        memory_available_gb = memory.available / (1024**3)
        
        # Disk information
        disk = psutil.disk_usage('/')
        disk_total_gb = disk.total / (1024**3)
        disk_free_gb = disk.free / (1024**3)
        
        # GPU information
        gpu_available = torch.cuda.is_available()
        gpu_count = torch.cuda.device_count() if gpu_available else 0
        
        return {
            'cpu': {
                'cores': cpu_count,
                'frequency_mhz': cpu_freq.current if cpu_freq else None,
                'recommended_threads': max(1, cpu_count - 1)
            },
            'memory': {
                'total_gb': round(memory_gb, 1),
                'available_gb': round(memory_available_gb, 1),
                'usage_percent': memory.percent,
                'recommended_max_concurrent': max(1, int(memory_gb / 2))
            },
            'disk': {
                'total_gb': round(disk_total_gb, 1),
                'free_gb': round(disk_free_gb, 1),
                'usage_percent': round((disk.used / disk.total) * 100, 1)
            },
            'gpu': {
                'available': gpu_available,
                'count': gpu_count,
                'recommended_use': gpu_available and memory_gb >= 8
            },
            'recommendations': _get_recommendations(cpu_count, memory_gb, gpu_available)
        }
        
    except ImportError as e:
        logger.warning(f"Could not import required modules: {e}")
        return _get_alternative_system_info()


def _get_recommendations(cpu_count: int, memory_gb: float, gpu_available: bool) -> Dict[str, Any]:
    """Get configuration recommendations based on system resources"""
    return {
        'max_concurrent_requests': min(max(1, cpu_count - 1), max(1, int(memory_gb / 4))),  # More conservative memory calc
        'max_requests_per_user': 1 if memory_gb <= 8 else 2,
        'max_image_size_mb': 100,  # Fixed 100MB as requested
        'target_image_size_mb': None,  # No target size as requested
        'use_gpu': gpu_available and memory_gb >= 8,
        'memory_threshold': 75 if memory_gb <= 8 else (80 if memory_gb <= 16 else 85),
        'cpu_threshold': 80 if cpu_count <= 2 else (85 if cpu_count <= 4 else 90)
    }


def _get_alternative_system_info() -> Dict[str, Any]:
    """Alternative system info detection when psutil is not available"""
    import os
    import platform
    
    # Try to get CPU count from os module
    try:
        cpu_count = os.cpu_count() or 2
    except:
        cpu_count = 2
    
    # Try to detect memory from /proc/meminfo on Linux
    memory_gb = _detect_memory_alternative()
    
    # Try to detect disk space
    disk_gb = _detect_disk_alternative()
    
    # GPU detection (basic)
    gpu_available = False
    try:
        import torch
        gpu_available = torch.cuda.is_available()
    except:
        pass
    
    return {
        'cpu': {
            'cores': cpu_count,
            'frequency_mhz': None,
            'recommended_threads': max(1, cpu_count - 1)
        },
        'memory': {
            'total_gb': round(memory_gb, 1),
            'available_gb': round(memory_gb * 0.7, 1),  # Estimate 70% available
            'usage_percent': 30.0,  # Estimate
            'recommended_max_concurrent': max(1, int(memory_gb / 2))
        },
        'disk': {
            'total_gb': round(disk_gb, 1),
            'free_gb': round(disk_gb * 0.7, 1),  # Estimate 70% free
            'usage_percent': 30.0  # Estimate
        },
        'gpu': {
            'available': gpu_available,
            'count': 1 if gpu_available else 0,
            'recommended_use': gpu_available and memory_gb >= 8
        },
        'recommendations': _get_recommendations(cpu_count, memory_gb, gpu_available)
    }


def _detect_memory_alternative() -> float:
    """Detect memory using alternative methods"""
    try:
        # Try macOS sysctl first
        import subprocess
        result = subprocess.run(['sysctl', '-n', 'hw.memsize'], 
                              capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            mem_bytes = int(result.stdout.strip())
            return mem_bytes / (1024**3)
    except:
        pass
    
    try:
        # Try macOS system_profiler
        import subprocess
        result = subprocess.run(['system_profiler', 'SPHardwareDataType'], 
                              capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            for line in result.stdout.split('\n'):
                if 'Memory:' in line:
                    # Extract memory value (e.g., "Memory: 18 GB")
                    parts = line.split()
                    for i, part in enumerate(parts):
                        if 'GB' in part and i > 0:
                            try:
                                mem_gb = float(parts[i-1])
                                return mem_gb
                            except:
                                pass
    except:
        pass
    
    try:
        # Try Linux /proc/meminfo
        if os.path.exists('/proc/meminfo'):
            with open('/proc/meminfo', 'r') as f:
                for line in f:
                    if line.startswith('MemTotal:'):
                        # Extract memory in KB and convert to GB
                        mem_kb = int(line.split()[1])
                        return mem_kb / (1024 * 1024)
    except:
        pass
    
    try:
        # Try Windows wmic
        import subprocess
        result = subprocess.run(['wmic', 'computersystem', 'get', 'TotalPhysicalMemory', '/value'], 
                              capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            for line in result.stdout.split('\n'):
                if 'TotalPhysicalMemory=' in line:
                    mem_bytes = int(line.split('=')[1])
                    return mem_bytes / (1024**3)
    except:
        pass
    
    # Fallback - return a reasonable default for modern systems
    return 16.0  # 16GB default


def _detect_disk_alternative() -> float:
    """Detect disk space using alternative methods"""
    try:
        import shutil
        total, used, free = shutil.disk_usage('/')
        return total / (1024**3)
    except:
        pass
    
    # Fallback
    return 100.0  # 100GB default