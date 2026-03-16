"""
Management command to display auto-detected system configuration for AI processing
"""
from django.core.management.base import BaseCommand
from ai_engine.system_info import get_system_info
from ai_engine.model_manager import get_model_manager
from ai_engine.resource_manager import get_resource_manager


class Command(BaseCommand):
    help = 'Display auto-detected system configuration for AI processing'

    def handle(self, *args, **options):
        self.stdout.write(self.style.SUCCESS('=== AI Processing System Configuration ===\n'))
        
        # Get system information
        system_info = get_system_info()
        
        # Display hardware information
        self.stdout.write(self.style.HTTP_INFO('Hardware Information:'))
        cpu_info = system_info['cpu']
        memory_info = system_info['memory']
        disk_info = system_info['disk']
        gpu_info = system_info['gpu']
        
        self.stdout.write(f"  CPU Cores: {cpu_info['cores']}")
        if cpu_info['frequency_mhz']:
            self.stdout.write(f"  CPU Frequency: {cpu_info['frequency_mhz']:.0f} MHz")
        
        self.stdout.write(f"  Total Memory: {memory_info['total_gb']:.1f} GB")
        self.stdout.write(f"  Available Memory: {memory_info['available_gb']:.1f} GB")
        self.stdout.write(f"  Memory Usage: {memory_info['usage_percent']:.1f}%")
        
        self.stdout.write(f"  Total Disk: {disk_info['total_gb']:.1f} GB")
        self.stdout.write(f"  Free Disk: {disk_info['free_gb']:.1f} GB")
        
        self.stdout.write(f"  GPU Available: {gpu_info['available']}")
        if gpu_info['available']:
            self.stdout.write(f"  GPU Count: {gpu_info['count']}")
        
        # Display AI configuration
        self.stdout.write(f"\n{self.style.HTTP_INFO('AI Processing Configuration:')}")
        recommendations = system_info['recommendations']
        
        self.stdout.write(f"  Max Concurrent Requests: {recommendations['max_concurrent_requests']}")
        self.stdout.write(f"  Max Requests Per User: {recommendations['max_requests_per_user']}")
        self.stdout.write(f"  Max Image Size: {recommendations['max_image_size_mb']} MB")
        self.stdout.write(f"  Target Image Size: {recommendations['target_image_size_mb']} MB")
        self.stdout.write(f"  Use GPU: {recommendations['use_gpu']}")
        self.stdout.write(f"  Memory Threshold: {recommendations['memory_threshold']}%")
        self.stdout.write(f"  CPU Threshold: {recommendations['cpu_threshold']}%")
        
        # Display current resource manager status
        try:
            resource_manager = get_resource_manager()
            metrics = resource_manager.get_resource_metrics()
            
            self.stdout.write(f"\n{self.style.HTTP_INFO('Current Resource Usage:')}")
            self.stdout.write(f"  CPU Usage: {metrics.cpu_percent:.1f}%")
            self.stdout.write(f"  Memory Usage: {metrics.memory_percent:.1f}%")
            self.stdout.write(f"  Active Requests: {metrics.active_requests}")
            self.stdout.write(f"  Cache Hit Rate: {metrics.cache_hit_rate:.1%}")
            
        except Exception as e:
            self.stdout.write(f"\n{self.style.WARNING('Could not get current resource usage: ')}{e}")
        
        # Display model manager status
        try:
            model_manager = get_model_manager()
            
            self.stdout.write(f"\n{self.style.HTTP_INFO('Model Manager Configuration:')}")
            self.stdout.write(f"  GPU Available: {model_manager.is_gpu_available()}")
            self.stdout.write(f"  Device: {model_manager.get_device()}")
            self.stdout.write(f"  Cache Size: {model_manager.cache_size}")
            
        except Exception as e:
            self.stdout.write(f"\n{self.style.WARNING('Could not get model manager status: ')}{e}")
        
        self.stdout.write(f"\n{self.style.SUCCESS('Configuration complete - system auto-configured based on available resources')}")