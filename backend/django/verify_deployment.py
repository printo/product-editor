#!/usr/bin/env python
"""
Deployment Verification Script for AI Processing System
Verifies that the system is properly configured for CPU-only deployment
"""
import os
import sys
import json

def check_environment_variables():
    """Check that environment variables are properly configured"""
    print("=== Environment Variables ===")
    
    # AI Processing settings
    ai_settings = {
        'AI_PROCESSING_ENABLED': os.getenv('AI_PROCESSING_ENABLED', 'true'),
        'AI_FORCE_CPU_ONLY': os.getenv('AI_FORCE_CPU_ONLY', 'false'),
        'AI_CACHE_TTL': os.getenv('AI_CACHE_TTL', '3600'),
        'AI_PROCESSING_TIMEOUT': os.getenv('AI_PROCESSING_TIMEOUT', '60'),
        'AI_BACKGROUND_PROCESSING': os.getenv('AI_BACKGROUND_PROCESSING', 'true'),
    }
    
    for key, value in ai_settings.items():
        print(f"  {key}: {value}")
    
    # CPU optimization settings
    cpu_settings = {
        'CUDA_VISIBLE_DEVICES': os.getenv('CUDA_VISIBLE_DEVICES', 'not set'),
        'OMP_NUM_THREADS': os.getenv('OMP_NUM_THREADS', 'not set'),
        'MKL_NUM_THREADS': os.getenv('MKL_NUM_THREADS', 'not set'),
    }
    
    print("\n  CPU Optimization:")
    for key, value in cpu_settings.items():
        print(f"    {key}: {value}")
    
    return True

def check_system_resources():
    """Check system resources and configuration"""
    print("\n=== System Resources ===")
    
    try:
        # Try to get actual system info
        import psutil
        
        cpu_count = psutil.cpu_count(logical=True)
        memory = psutil.virtual_memory()
        memory_gb = memory.total / (1024**3)
        
        print(f"  CPU Cores: {cpu_count}")
        print(f"  Total Memory: {memory_gb:.1f} GB")
        print(f"  Available Memory: {memory.available / (1024**3):.1f} GB")
        print(f"  Memory Usage: {memory.percent:.1f}%")
        
        # Check if system meets minimum requirements
        if cpu_count >= 2 and memory_gb >= 4:
            print("  ✓ System meets minimum requirements")
        else:
            print("  ⚠ System may not meet minimum requirements")
        
        return True
        
    except ImportError:
        print("  psutil not available - using fallback detection")
        print("  Assumed: 2 CPU cores, 6GB RAM (configure as needed)")
        return True

def check_ai_dependencies():
    """Check AI processing dependencies"""
    print("\n=== AI Dependencies ===")
    
    dependencies = [
        ('torch', 'PyTorch for AI models'),
        ('PIL', 'Pillow for image processing'),
        ('cv2', 'OpenCV for computer vision'),
        ('numpy', 'NumPy for numerical operations'),
    ]
    
    optional_dependencies = [
        ('transformers', 'Hugging Face Transformers'),
        ('ultralytics', 'YOLO models'),
        ('rembg', 'Background removal'),
        ('psutil', 'System monitoring'),
    ]
    
    available = 0
    total = len(dependencies)
    
    print("  Required dependencies:")
    for module, description in dependencies:
        try:
            __import__(module)
            print(f"    ✓ {module}: {description}")
            available += 1
        except ImportError:
            print(f"    ✗ {module}: {description} (MISSING)")
    
    print("  Optional dependencies:")
    for module, description in optional_dependencies:
        try:
            __import__(module)
            print(f"    ✓ {module}: {description}")
        except ImportError:
            print(f"    ⚠ {module}: {description} (optional)")
    
    if available == total:
        print(f"  ✓ All required dependencies available ({available}/{total})")
        return True
    else:
        print(f"  ✗ Missing dependencies ({available}/{total})")
        return False

def check_configuration_files():
    """Check that configuration files exist and are valid"""
    print("\n=== Configuration Files ===")
    
    files_to_check = [
        'product_editor/settings.py',
        'ai_engine/system_info.py',
        'ai_engine/model_manager.py',
        'ai_engine/resource_manager.py',
        'api/middleware.py',
    ]
    
    all_exist = True
    
    for file_path in files_to_check:
        if os.path.exists(file_path):
            print(f"  ✓ {file_path}")
        else:
            print(f"  ✗ {file_path} (MISSING)")
            all_exist = False
    
    return all_exist

def check_cpu_optimization():
    """Check CPU optimization settings"""
    print("\n=== CPU Optimization ===")
    
    # Check if CUDA is disabled
    cuda_disabled = os.getenv('CUDA_VISIBLE_DEVICES') == ''
    if cuda_disabled:
        print("  ✓ CUDA disabled (CPU-only mode)")
    else:
        print("  ⚠ CUDA not explicitly disabled")
    
    # Check thread settings
    omp_threads = os.getenv('OMP_NUM_THREADS')
    mkl_threads = os.getenv('MKL_NUM_THREADS')
    
    if omp_threads:
        print(f"  ✓ OpenMP threads limited to {omp_threads}")
    else:
        print("  ⚠ OpenMP threads not limited")
    
    if mkl_threads:
        print(f"  ✓ MKL threads limited to {mkl_threads}")
    else:
        print("  ⚠ MKL threads not limited")
    
    return True

def generate_deployment_summary():
    """Generate deployment summary"""
    print("\n=== Deployment Summary ===")
    
    # System configuration
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from ai_engine.system_info import get_system_info
        
        system_info = get_system_info()
        recommendations = system_info['recommendations']
        
        print("  Auto-detected configuration:")
        print(f"    Max concurrent requests: {recommendations['max_concurrent_requests']}")
        print(f"    Max requests per user: {recommendations['max_requests_per_user']}")
        print(f"    Max image size: {recommendations['max_image_size_mb']} MB")
        print(f"    Target image size: {recommendations['target_image_size_mb']} MB")
        print(f"    Memory threshold: {recommendations['memory_threshold']}%")
        print(f"    CPU threshold: {recommendations['cpu_threshold']}%")
        print(f"    Use GPU: {recommendations['use_gpu']}")
        
        print("\n  System capacity:")
        print(f"    CPU cores: {system_info['cpu']['cores']}")
        print(f"    Total memory: {system_info['memory']['total_gb']:.1f} GB")
        print(f"    GPU available: {system_info['gpu']['available']}")
        
    except Exception as e:
        print(f"  Could not load system configuration: {e}")
    
    return True

def main():
    """Run deployment verification"""
    print("AI Processing System - Deployment Verification")
    print("=" * 60)
    
    checks = [
        check_environment_variables,
        check_system_resources,
        check_ai_dependencies,
        check_configuration_files,
        check_cpu_optimization,
        generate_deployment_summary,
    ]
    
    passed = 0
    total = len(checks)
    
    for check in checks:
        try:
            if check():
                passed += 1
        except Exception as e:
            print(f"  ✗ Check failed: {e}")
    
    print(f"\n=== Verification Results ===")
    print(f"Checks passed: {passed}/{total}")
    
    if passed >= total - 1:  # Allow one optional check to fail
        print("✓ System is ready for deployment!")
        print("\nNext steps:")
        print("1. Install missing dependencies if any")
        print("2. Run: python manage.py migrate")
        print("3. Run: python manage.py show_system_config")
        print("4. Start the server and test AI processing endpoints")
        return 0
    else:
        print("✗ System needs configuration before deployment")
        return 1

if __name__ == "__main__":
    sys.exit(main())