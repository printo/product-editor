"""
AI Model Manager for Product Editor
Handles loading, caching, and lifecycle management of ML models
"""
import os
import torch
import logging
from typing import Dict, Optional, Any
from dataclasses import dataclass
from datetime import datetime, timedelta
import threading
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class ModelStatus:
    """Status information for an AI model"""
    name: str
    is_loaded: bool
    is_healthy: bool
    load_time: Optional[float]
    memory_usage: Optional[int]
    last_used: Optional[datetime]
    error_message: Optional[str] = None


class AIModelManager:
    """Manages AI model loading, caching, and lifecycle"""
    
    def __init__(self, cache_size: int = None, model_dir: str = None):
        # Auto-detect system resources and configure accordingly
        self._detect_system_resources()
        
        # Set cache size based on available memory
        if cache_size is None:
            cache_size = self._calculate_optimal_cache_size()
        
        self.cache_size = cache_size
        self.model_dir = model_dir or os.path.join(os.getcwd(), 'ai_models')
        self._models: Dict[str, Any] = {}
        self._model_status: Dict[str, ModelStatus] = {}
        self._lock = threading.Lock()
        
        # Auto-detect GPU availability and system constraints
        self._gpu_available = self._should_use_gpu()
        
        if not self._gpu_available:
            # Optimize for CPU-only execution
            os.environ['CUDA_VISIBLE_DEVICES'] = ''
            os.environ['OMP_NUM_THREADS'] = str(self.cpu_cores)
            os.environ['MKL_NUM_THREADS'] = str(self.cpu_cores)
        
        # Create model directory if it doesn't exist
        Path(self.model_dir).mkdir(parents=True, exist_ok=True)
        
        logger.info(f"AI Model Manager initialized: GPU={self._gpu_available}, "
                   f"CPU cores={self.cpu_cores}, Memory={self.memory_gb:.1f}GB, "
                   f"Cache size={self.cache_size}")
    
    def _detect_system_resources(self):
        """Auto-detect system resources for optimal configuration"""
        from .system_info import get_system_info
        
        system_info = get_system_info()
        
        self.cpu_cores = system_info['cpu']['cores']
        self.memory_gb = system_info['memory']['total_gb']
        self.disk_gb = system_info['disk']['total_gb']
        self.system_recommendations = system_info['recommendations']
        
        logger.info(f"Detected system: {self.cpu_cores} CPU cores, "
                   f"{self.memory_gb:.1f}GB RAM, {self.disk_gb:.1f}GB disk")
    
    def _should_use_gpu(self) -> bool:
        """Determine if GPU should be used based on availability and system resources"""
        # Check Django settings first
        from django.conf import settings
        force_cpu = getattr(settings, 'AI_FORCE_CPU_ONLY', False)
        
        if force_cpu:
            return False
        
        # Check if GPU is available
        if not torch.cuda.is_available():
            return False
        
        # For low-memory systems, prefer CPU to avoid GPU memory overhead
        if self.memory_gb < 8:
            logger.info("Using CPU due to limited system memory (<8GB)")
            return False
        
        return True
    
    def _calculate_optimal_cache_size(self) -> int:
        """Calculate optimal cache size based on available memory"""
        # Use system recommendations if available
        if hasattr(self, 'system_recommendations'):
            if self.memory_gb >= 16:
                return 5  # High memory system
            elif self.memory_gb >= 8:
                return 3  # Medium memory system
            else:
                return 2  # Low memory system
        
        # Fallback calculation
        return 2 if self.memory_gb <= 8 else 3
    
    def is_gpu_available(self) -> bool:
        """Check if GPU is available for model acceleration"""
        return self._gpu_available
    
    def get_device(self) -> str:
        """Get the appropriate device (cuda/cpu) for model loading"""
        return "cuda" if self._gpu_available else "cpu"
    
    def load_model(self, model_name: str, force_reload: bool = False) -> Any:
        """Load and cache an AI model"""
        with self._lock:
            # Check if model is already loaded
            if model_name in self._models and not force_reload:
                self._update_last_used(model_name)
                return self._models[model_name]
            
            # Check cache size and cleanup if needed
            if len(self._models) >= self.cache_size:
                self._cleanup_least_used()
            
            try:
                start_time = datetime.now()
                model = self._load_model_instance(model_name)
                load_time = (datetime.now() - start_time).total_seconds()
                
                # Cache the model
                self._models[model_name] = model
                self._model_status[model_name] = ModelStatus(
                    name=model_name,
                    is_loaded=True,
                    is_healthy=True,
                    load_time=load_time,
                    memory_usage=self._get_model_memory_usage(model),
                    last_used=datetime.now()
                )
                
                logger.info(f"Model {model_name} loaded successfully in {load_time:.2f}s")
                return model
                
            except Exception as e:
                error_msg = f"Failed to load model {model_name}: {str(e)}"
                logger.error(error_msg)
                
                self._model_status[model_name] = ModelStatus(
                    name=model_name,
                    is_loaded=False,
                    is_healthy=False,
                    load_time=None,
                    memory_usage=None,
                    last_used=None,
                    error_message=error_msg
                )
                raise
    
    def _load_model_instance(self, model_name: str) -> Any:
        """Load specific model instance based on model name with CPU optimization"""
        device = self.get_device()
        
        if model_name == "rmbg":
            from rembg import remove, new_session
            # Use CPU-optimized session for background removal
            return new_session('u2net')
        
        elif model_name == "yolo":
            from ultralytics import YOLO
            model_path = os.path.join(self.model_dir, 'yolov8n.pt')
            
            # Load YOLO model with CPU optimization
            model = YOLO(model_path)
            
            # Configure for CPU-only inference
            if device == "cpu":
                # Set CPU-specific optimizations
                model.overrides['device'] = 'cpu'
                model.overrides['half'] = False  # Disable half precision on CPU
                model.overrides['batch'] = 1  # Single batch for memory efficiency
                
            return model
        
        else:
            raise ValueError(f"Unknown model: {model_name}")
    
    def get_model_status(self, model_name: str) -> ModelStatus:
        """Get status information for a model"""
        return self._model_status.get(model_name, ModelStatus(
            name=model_name,
            is_loaded=False,
            is_healthy=False,
            load_time=None,
            memory_usage=None,
            last_used=None,
            error_message="Model not loaded"
        ))
    
    def cleanup_unused_models(self, max_age_hours: int = 24) -> None:
        """Remove models that haven't been used recently"""
        with self._lock:
            cutoff_time = datetime.now() - timedelta(hours=max_age_hours)
            models_to_remove = []
            
            for model_name, status in self._model_status.items():
                if status.last_used and status.last_used < cutoff_time:
                    models_to_remove.append(model_name)
            
            for model_name in models_to_remove:
                self._remove_model(model_name)
                logger.info(f"Cleaned up unused model: {model_name}")
    
    def _cleanup_least_used(self) -> None:
        """Remove the least recently used model"""
        if not self._models:
            return
        
        # Find least recently used model
        lru_model = min(
            self._model_status.items(),
            key=lambda x: x[1].last_used or datetime.min
        )[0]
        
        self._remove_model(lru_model)
        logger.info(f"Removed LRU model: {lru_model}")
    
    def _remove_model(self, model_name: str) -> None:
        """Remove a model from cache"""
        if model_name in self._models:
            del self._models[model_name]
        if model_name in self._model_status:
            del self._model_status[model_name]
    
    def _update_last_used(self, model_name: str) -> None:
        """Update the last used timestamp for a model"""
        if model_name in self._model_status:
            self._model_status[model_name].last_used = datetime.now()
    
    def _get_model_memory_usage(self, model) -> Optional[int]:
        """Estimate memory usage of a model"""
        try:
            if hasattr(model, 'parameters'):
                return sum(p.numel() * p.element_size() for p in model.parameters())
            return None
        except:
            return None


# Global instance
_model_manager = None

def get_model_manager() -> AIModelManager:
    """Get the global model manager instance"""
    global _model_manager
    if _model_manager is None:
        _model_manager = AIModelManager()
    return _model_manager