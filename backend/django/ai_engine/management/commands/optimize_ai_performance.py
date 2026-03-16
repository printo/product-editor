"""
Django management command for AI performance optimization
Usage: python manage.py optimize_ai_performance [--profile] [--optimize] [--report]
"""
import json
import time
from datetime import datetime
from django.core.management.base import BaseCommand, CommandError
from django.conf import settings
from ai_engine.performance_optimizer import get_performance_optimizer
from ai_engine.resource_manager import get_resource_manager


class Command(BaseCommand):
    help = 'Optimize AI processing performance and generate reports'
    
    def add_arguments(self, parser):
        parser.add_argument(
            '--profile',
            action='store_true',
            help='Start performance profiling for specified duration'
        )
        parser.add_argument(
            '--duration',
            type=int,
            default=300,
            help='Profiling duration in seconds (default: 300)'
        )
        parser.add_argument(
            '--optimize',
            action='store_true',
            help='Run comprehensive optimization analysis'
        )
        parser.add_argument(
            '--report',
            action='store_true',
            help='Generate performance report'
        )
        parser.add_argument(
            '--output',
            type=str,
            help='Output file for reports (JSON format)'
        )
        parser.add_argument(
            '--continuous',
            action='store_true',
            help='Start continuous optimization monitoring'
        )
    
    def handle(self, *args, **options):
        profile = options['profile']
        duration = options['duration']
        optimize = options['optimize']
        report = options['report']
        output_file = options['output']
        continuous = options['continuous']
        
        optimizer = get_performance_optimizer()
        
        try:
            if continuous:
                self._run_continuous_monitoring(optimizer)
            elif profile:
                self._run_profiling(optimizer, duration)
            elif optimize:
                self._run_optimization(optimizer, output_file)
            elif report:
                self._generate_report(optimizer, output_file)
            else:
                self.stdout.write(
                    self.style.WARNING('No action specified. Use --profile, --optimize, --report, or --continuous')
                )
                
        except KeyboardInterrupt:
            self.stdout.write(self.style.WARNING('Operation interrupted by user'))
        except Exception as e:
            raise CommandError(f'Performance optimization failed: {str(e)}')
    
    def _run_profiling(self, optimizer, duration):
        """Run performance profiling for specified duration"""
        self.stdout.write(f'Starting performance profiling for {duration} seconds...')
        
        optimizer.start_continuous_optimization()
        
        try:
            # Display real-time stats
            start_time = time.time()
            while time.time() - start_time < duration:
                # Get current metrics
                resource_manager = get_resource_manager()
                metrics = resource_manager.get_resource_metrics()
                
                self.stdout.write(
                    f'\r[{int(time.time() - start_time):3d}s] '
                    f'CPU: {metrics.cpu_percent:5.1f}% | '
                    f'Memory: {metrics.memory_percent:5.1f}% | '
                    f'Active: {metrics.active_requests} | '
                    f'Cache: {metrics.cache_hit_rate:5.1%}',
                    ending=''
                )
                
                time.sleep(1)
            
            self.stdout.write('')  # New line
            
        finally:
            optimizer.stop_continuous_optimization()
        
        # Generate summary
        summary = optimizer.profiler.get_performance_summary()
        self._display_performance_summary(summary)
        
        self.stdout.write(self.style.SUCCESS('Performance profiling completed'))
    
    def _run_optimization(self, optimizer, output_file):
        """Run comprehensive optimization analysis"""
        self.stdout.write('Running comprehensive performance optimization...')
        
        results = optimizer.run_comprehensive_optimization()
        
        # Display results
        self._display_optimization_results(results)
        
        # Save to file if specified
        if output_file:
            self._save_results_to_file(results, output_file)
        
        self.stdout.write(self.style.SUCCESS('Performance optimization completed'))
    
    def _generate_report(self, optimizer, output_file):
        """Generate detailed performance report"""
        self.stdout.write('Generating performance report...')
        
        # Collect comprehensive data
        report_data = {
            'timestamp': datetime.now().isoformat(),
            'system_info': self._get_system_info(),
            'performance_summary': optimizer.profiler.get_performance_summary(),
            'cache_analysis': optimizer.cache_optimizer.analyze_cache_performance(),
            'memory_analysis': optimizer.memory_optimizer.analyze_memory_patterns(),
            'gpu_analysis': optimizer.gpu_optimizer.validate_gpu_acceleration(),
            'resource_stats': get_resource_manager().get_comprehensive_stats()
        }
        
        # Display summary
        self._display_report_summary(report_data)
        
        # Save to file
        if output_file:
            self._save_results_to_file(report_data, output_file)
        else:
            # Default filename
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            default_file = f'ai_performance_report_{timestamp}.json'
            self._save_results_to_file(report_data, default_file)
        
        self.stdout.write(self.style.SUCCESS('Performance report generated'))
    
    def _run_continuous_monitoring(self, optimizer):
        """Run continuous performance monitoring"""
        self.stdout.write('Starting continuous performance monitoring...')
        self.stdout.write('Press Ctrl+C to stop')
        
        optimizer.start_continuous_optimization()
        
        try:
            while True:
                # Display current status every 30 seconds
                resource_manager = get_resource_manager()
                metrics = resource_manager.get_resource_metrics()
                
                timestamp = datetime.now().strftime('%H:%M:%S')
                self.stdout.write(
                    f'[{timestamp}] '
                    f'CPU: {metrics.cpu_percent:5.1f}% | '
                    f'Memory: {metrics.memory_percent:5.1f}% | '
                    f'Active Requests: {metrics.active_requests} | '
                    f'Cache Hit Rate: {metrics.cache_hit_rate:5.1%}'
                )
                
                # Check for performance issues
                alerts = []
                if metrics.cpu_percent > 90:
                    alerts.append("HIGH CPU USAGE")
                if metrics.memory_percent > 90:
                    alerts.append("HIGH MEMORY USAGE")
                if metrics.cache_hit_rate < 0.3:
                    alerts.append("LOW CACHE HIT RATE")
                
                if alerts:
                    self.stdout.write(
                        self.style.WARNING(f'ALERTS: {", ".join(alerts)}')
                    )
                
                time.sleep(30)
                
        finally:
            optimizer.stop_continuous_optimization()
            self.stdout.write(self.style.SUCCESS('Continuous monitoring stopped'))
    
    def _display_performance_summary(self, summary):
        """Display performance summary"""
        if 'error' in summary:
            self.stdout.write(self.style.ERROR(f'Error: {summary["error"]}'))
            return
        
        self.stdout.write(self.style.HTTP_INFO('\n=== Performance Summary ==='))
        
        if 'execution_time' in summary:
            exec_time = summary['execution_time']
            self.stdout.write(f'Execution Time:')
            self.stdout.write(f'  Average: {exec_time["mean"]:.2f}s')
            self.stdout.write(f'  Median:  {exec_time["median"]:.2f}s')
            self.stdout.write(f'  Range:   {exec_time["min"]:.2f}s - {exec_time["max"]:.2f}s')
        
        if 'throughput_ops_per_second' in summary:
            throughput = summary['throughput_ops_per_second']
            self.stdout.write(f'\nThroughput:')
            self.stdout.write(f'  Average: {throughput["mean"]:.2f} ops/sec')
            self.stdout.write(f'  Peak:    {throughput["max"]:.2f} ops/sec')
        
        if 'error_rate' in summary:
            self.stdout.write(f'\nError Rate: {summary["error_rate"]:.1%}')
        
        if 'cache_hit_rate' in summary:
            self.stdout.write(f'Cache Hit Rate: {summary["cache_hit_rate"]:.1%}')
    
    def _display_optimization_results(self, results):
        """Display optimization results"""
        self.stdout.write(self.style.HTTP_INFO('\n=== Optimization Results ==='))
        
        # Cache optimization
        if 'cache' in results.get('optimizations', {}):
            cache_results = results['optimizations']['cache']
            self.stdout.write(f'\nCache Analysis:')
            if 'current_stats' in cache_results:
                stats = cache_results['current_stats']
                self.stdout.write(f'  Hit Rate: {stats.get("hit_rate", 0):.1%}')
                self.stdout.write(f'  Total Requests: {stats.get("total_requests", 0)}')
            
            if 'recommendations' in cache_results:
                self.stdout.write('  Recommendations:')
                for rec in cache_results['recommendations']:
                    self.stdout.write(f'    - {rec}')
        
        # Memory optimization
        if 'memory' in results.get('optimizations', {}):
            memory_results = results['optimizations']['memory']
            self.stdout.write(f'\nMemory Analysis:')
            if 'current_usage' in memory_results:
                self.stdout.write(f'  Current Usage: {memory_results["current_usage"]:.1f}%')
                self.stdout.write(f'  Average Usage: {memory_results.get("average_usage", 0):.1f}%')
                self.stdout.write(f'  Peak Usage: {memory_results.get("peak_usage", 0):.1f}%')
            
            if 'recommendations' in memory_results:
                self.stdout.write('  Recommendations:')
                for rec in memory_results['recommendations']:
                    self.stdout.write(f'    - {rec}')
        
        # GPU optimization
        if 'gpu' in results.get('optimizations', {}):
            gpu_results = results['optimizations']['gpu']
            self.stdout.write(f'\nGPU Analysis:')
            self.stdout.write(f'  GPU Available: {gpu_results.get("gpu_available", False)}')
            
            if gpu_results.get('gpu_available') and 'performance_test' in gpu_results:
                perf = gpu_results['performance_test']
                self.stdout.write(f'  Speedup Factor: {perf.get("speedup_factor", 0):.1f}x')
            
            if 'recommendation' in gpu_results:
                self.stdout.write(f'  Recommendation: {gpu_results["recommendation"]}')
        
        # Overall recommendations
        if 'overall_recommendations' in results:
            self.stdout.write(f'\nOverall Recommendations:')
            for rec in results['overall_recommendations']:
                self.stdout.write(f'  - {rec}')
    
    def _display_report_summary(self, report_data):
        """Display report summary"""
        self.stdout.write(self.style.HTTP_INFO('\n=== Performance Report Summary ==='))
        
        # System info
        if 'system_info' in report_data:
            sys_info = report_data['system_info']
            self.stdout.write(f'System: {sys_info.get("platform", "Unknown")}')
            self.stdout.write(f'CPU Cores: {sys_info.get("cpu_cores", "Unknown")}')
            self.stdout.write(f'Total Memory: {sys_info.get("total_memory_gb", 0):.1f} GB')
        
        # Performance summary
        if 'performance_summary' in report_data:
            perf = report_data['performance_summary']
            if 'total_operations' in perf:
                self.stdout.write(f'Total Operations Analyzed: {perf["total_operations"]}')
        
        # Key metrics
        if 'resource_stats' in report_data:
            stats = report_data['resource_stats']
            if 'result_cache' in stats:
                cache_stats = stats['result_cache']
                self.stdout.write(f'Cache Hit Rate: {cache_stats.get("hit_rate", 0):.1%}')
    
    def _get_system_info(self):
        """Get system information"""
        import platform
        import psutil
        
        return {
            'platform': platform.platform(),
            'python_version': platform.python_version(),
            'cpu_cores': psutil.cpu_count(),
            'total_memory_gb': psutil.virtual_memory().total / (1024**3),
            'django_version': getattr(settings, 'DJANGO_VERSION', 'Unknown')
        }
    
    def _save_results_to_file(self, data, filename):
        """Save results to JSON file"""
        try:
            with open(filename, 'w') as f:
                json.dump(data, f, indent=2, default=str)
            
            self.stdout.write(f'Results saved to: {filename}')
            
        except Exception as e:
            self.stdout.write(self.style.ERROR(f'Failed to save results: {e}'))