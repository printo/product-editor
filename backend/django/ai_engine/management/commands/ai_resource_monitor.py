"""
Django management command for AI resource monitoring and maintenance
Usage: python manage.py ai_resource_monitor [--interval=60] [--cleanup] [--stats]
"""
import time
import logging
from datetime import datetime
from django.core.management.base import BaseCommand, CommandError
from django.conf import settings
from ai_engine.resource_manager import get_resource_manager
from ai_engine.network_resilience import get_resilient_client
from ai_engine.background_processor import get_background_processor

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Monitor and maintain AI resource management system'
    
    def add_arguments(self, parser):
        parser.add_argument(
            '--interval',
            type=int,
            default=60,
            help='Monitoring interval in seconds (default: 60)'
        )
        parser.add_argument(
            '--cleanup',
            action='store_true',
            help='Perform cleanup and maintenance tasks'
        )
        parser.add_argument(
            '--stats',
            action='store_true',
            help='Display current resource statistics'
        )
        parser.add_argument(
            '--daemon',
            action='store_true',
            help='Run as daemon (continuous monitoring)'
        )
        parser.add_argument(
            '--alert-threshold',
            type=float,
            default=0.8,
            help='Resource usage threshold for alerts (0.0-1.0)'
        )
    
    def handle(self, *args, **options):
        interval = options['interval']
        cleanup = options['cleanup']
        stats = options['stats']
        daemon = options['daemon']
        alert_threshold = options['alert_threshold']
        
        self.stdout.write(
            self.style.SUCCESS(f'Starting AI Resource Monitor (interval: {interval}s)')
        )
        
        try:
            resource_manager = get_resource_manager()
            resilient_client = get_resilient_client()
            background_processor = get_background_processor()
            
            if cleanup:
                self._perform_cleanup(resource_manager)
                return
            
            if stats:
                self._display_stats(resource_manager, resilient_client, background_processor)
                return
            
            if daemon:
                self._run_daemon(resource_manager, resilient_client, background_processor, 
                               interval, alert_threshold)
            else:
                self._single_check(resource_manager, resilient_client, background_processor, 
                                 alert_threshold)
                
        except KeyboardInterrupt:
            self.stdout.write(self.style.WARNING('Monitoring stopped by user'))
        except Exception as e:
            raise CommandError(f'Resource monitoring failed: {str(e)}')
    
    def _perform_cleanup(self, resource_manager):
        """Perform cleanup and maintenance tasks"""
        self.stdout.write('Performing resource cleanup...')
        
        try:
            # Perform maintenance
            resource_manager.perform_maintenance()
            
            # Get stats after cleanup
            stats = resource_manager.get_comprehensive_stats()
            
            self.stdout.write(self.style.SUCCESS('Cleanup completed successfully'))
            self.stdout.write(f"Memory optimizer: {stats['memory_optimizer']['mb_saved']:.1f} MB saved")
            self.stdout.write(f"Cache stats: {stats['result_cache']['hits']} hits, {stats['result_cache']['misses']} misses")
            
        except Exception as e:
            self.stdout.write(self.style.ERROR(f'Cleanup failed: {str(e)}'))
    
    def _display_stats(self, resource_manager, resilient_client, background_processor):
        """Display current resource statistics"""
        self.stdout.write(self.style.HTTP_INFO('=== AI Resource Statistics ==='))
        
        try:
            # Resource manager stats
            stats = resource_manager.get_comprehensive_stats()
            metrics = resource_manager.get_resource_metrics()
            
            self.stdout.write(f"\n{self.style.HTTP_INFO('System Resources:')}")
            self.stdout.write(f"  CPU Usage: {metrics.cpu_percent:.1f}%")
            self.stdout.write(f"  Memory Usage: {metrics.memory_percent:.1f}%")
            self.stdout.write(f"  Available Memory: {metrics.memory_available_mb:.0f} MB")
            
            self.stdout.write(f"\n{self.style.HTTP_INFO('Request Management:')}")
            limiter_stats = stats['request_limiter']
            self.stdout.write(f"  Active Requests: {limiter_stats['active_requests']}/{limiter_stats['max_concurrent']}")
            self.stdout.write(f"  Utilization: {limiter_stats['utilization']:.1%}")
            self.stdout.write(f"  User Counts: {limiter_stats['user_counts']}")
            
            self.stdout.write(f"\n{self.style.HTTP_INFO('Result Cache:')}")
            cache_stats = stats['result_cache']
            self.stdout.write(f"  Hit Rate: {cache_stats['hit_rate']:.1%}")
            self.stdout.write(f"  Total Requests: {cache_stats['total_requests']}")
            self.stdout.write(f"  Hits: {cache_stats['hits']}, Misses: {cache_stats['misses']}")
            
            self.stdout.write(f"\n{self.style.HTTP_INFO('Memory Optimization:')}")
            memory_stats = stats['memory_optimizer']
            self.stdout.write(f"  Images Processed: {memory_stats['processed_images']}")
            self.stdout.write(f"  Space Saved: {memory_stats['mb_saved']:.1f} MB")
            
            # Network resilience stats
            network_stats = resilient_client.get_status()
            self.stdout.write(f"\n{self.style.HTTP_INFO('Network Resilience:')}")
            self.stdout.write(f"  Network Status: {network_stats['network_health']['status']}")
            self.stdout.write(f"  Queue Size: {network_stats['request_queue']['queue_size']}")
            
            # Background processing stats
            bg_stats = background_processor.get_queue_stats()
            self.stdout.write(f"\n{self.style.HTTP_INFO('Background Processing:')}")
            self.stdout.write(f"  Queue Size: {bg_stats['queue_size']}")
            self.stdout.write(f"  Active Jobs: {bg_stats['active_jobs']}")
            self.stdout.write(f"  Workers: {bg_stats['workers']}")
            
        except Exception as e:
            self.stdout.write(self.style.ERROR(f'Failed to get statistics: {str(e)}'))
    
    def _single_check(self, resource_manager, resilient_client, background_processor, alert_threshold):
        """Perform a single resource check"""
        try:
            metrics = resource_manager.get_resource_metrics()
            
            # Check for alerts
            alerts = []
            if metrics.cpu_percent / 100 > alert_threshold:
                alerts.append(f"High CPU usage: {metrics.cpu_percent:.1f}%")
            
            if metrics.memory_percent / 100 > alert_threshold:
                alerts.append(f"High memory usage: {metrics.memory_percent:.1f}%")
            
            if metrics.active_requests > 4:
                alerts.append(f"High request load: {metrics.active_requests} active requests")
            
            if metrics.cache_hit_rate < 0.3:
                alerts.append(f"Low cache hit rate: {metrics.cache_hit_rate:.1%}")
            
            # Display results
            timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            self.stdout.write(f"[{timestamp}] Resource check completed")
            
            if alerts:
                self.stdout.write(self.style.WARNING('Alerts:'))
                for alert in alerts:
                    self.stdout.write(f"  - {alert}")
            else:
                self.stdout.write(self.style.SUCCESS('All systems normal'))
                
        except Exception as e:
            self.stdout.write(self.style.ERROR(f'Resource check failed: {str(e)}'))
    
    def _run_daemon(self, resource_manager, resilient_client, background_processor, 
                   interval, alert_threshold):
        """Run continuous monitoring daemon"""
        self.stdout.write(f'Running daemon mode (interval: {interval}s, threshold: {alert_threshold})')
        
        last_maintenance = datetime.now()
        maintenance_interval = getattr(settings, 'AI_MAINTENANCE_INTERVAL', 3600)
        
        while True:
            try:
                # Perform resource check
                self._single_check(resource_manager, resilient_client, background_processor, 
                                 alert_threshold)
                
                # Perform periodic maintenance
                if (datetime.now() - last_maintenance).total_seconds() > maintenance_interval:
                    self.stdout.write('Performing periodic maintenance...')
                    resource_manager.perform_maintenance()
                    last_maintenance = datetime.now()
                    self.stdout.write(self.style.SUCCESS('Maintenance completed'))
                
                # Wait for next check
                time.sleep(interval)
                
            except KeyboardInterrupt:
                break
            except Exception as e:
                self.stdout.write(self.style.ERROR(f'Monitoring error: {str(e)}'))
                time.sleep(interval)  # Continue monitoring despite errors