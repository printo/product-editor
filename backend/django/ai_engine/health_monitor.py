"""
AI Model Health Monitoring
Provides health checks and status monitoring for AI models
"""
import logging
from typing import Dict, List
from datetime import datetime
from dataclasses import asdict
from .model_manager import get_model_manager, ModelStatus

logger = logging.getLogger(__name__)


class AIHealthMonitor:
    """Monitors health and status of AI models"""
    
    def __init__(self):
        self.model_manager = get_model_manager()
    
    def check_all_models(self) -> Dict[str, Dict]:
        """Check health status of all known models"""
        models_to_check = ["rmbg", "yolo"]
        results = {}
        
        for model_name in models_to_check:
            try:
                status = self.model_manager.get_model_status(model_name)
                results[model_name] = {
                    "status": "healthy" if status.is_healthy else "unhealthy",
                    "is_loaded": status.is_loaded,
                    "load_time": status.load_time,
                    "memory_usage": status.memory_usage,
                    "last_used": status.last_used.isoformat() if status.last_used else None,
                    "error_message": status.error_message
                }
            except Exception as e:
                results[model_name] = {
                    "status": "error",
                    "is_loaded": False,
                    "error_message": str(e)
                }
        
        return results
    
    def check_system_resources(self) -> Dict[str, any]:
        """Check system resources for AI processing"""
        import psutil
        
        return {
            "gpu_available": self.model_manager.is_gpu_available(),
            "device": self.model_manager.get_device(),
            "memory_usage": {
                "total": psutil.virtual_memory().total,
                "available": psutil.virtual_memory().available,
                "percent": psutil.virtual_memory().percent
            },
            "cpu_usage": psutil.cpu_percent(interval=1),
            "timestamp": datetime.now().isoformat()
        }
    
    def get_comprehensive_status(self) -> Dict[str, any]:
        """Get comprehensive AI system status"""
        return {
            "models": self.check_all_models(),
            "system": self.check_system_resources(),
            "manager_stats": {
                "cache_size": len(self.model_manager._models),
                "max_cache_size": self.model_manager.cache_size
            }
        }


# Global instance
_health_monitor = None

def get_health_monitor() -> AIHealthMonitor:
    """Get the global health monitor instance"""
    global _health_monitor
    if _health_monitor is None:
        _health_monitor = AIHealthMonitor()
    return _health_monitor