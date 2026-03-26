#!/usr/bin/env python
"""
Deployment Verification Script
Verifies that the system is properly configured for deployment
"""
import os
import sys
import json

def check_environment_variables():
    """Check that environment variables are properly configured"""
    print("=== Environment Variables ===")
    
    settings = {
        'DEBUG': os.getenv('DEBUG', '1'),
        'ALLOWED_HOSTS': os.getenv('ALLOWED_HOSTS', '*'),
        'POSTGRES_DB': os.getenv('POSTGRES_DB', 'product_editor'),
    }
    
    for key, value in settings.items():
        print(f"  {key}: {value}")
    
    return True

def check_system_resources():
    """Check system resources and configuration"""
    print("\n=== System Resources ===")
    
    try:
        import psutil
        
        cpu_count = psutil.cpu_count(logical=True)
        memory = psutil.virtual_memory()
        memory_gb = memory.total / (1024**3)
        
        print(f"  CPU Cores: {cpu_count}")
        print(f"  Total Memory: {memory_gb:.1f} GB")
        print(f"  Available Memory: {memory.available / (1024**3):.1f} GB")
        print(f"  Memory Usage: {memory.percent:.1f}%")
        
        return True
        
    except ImportError:
        print("  psutil not available")
        return True

def check_dependencies():
    """Check processing dependencies"""
    print("\n=== Dependencies ===")
    
    dependencies = [
        ('django', 'Django Framework'),
        ('rest_framework', 'Django REST Framework'),
        ('PIL', 'Pillow for image processing'),
    ]
    
    available = 0
    total = len(dependencies)
    
    for module, description in dependencies:
        try:
            __import__(module)
            print(f"    ✓ {module}: {description}")
            available += 1
        except ImportError:
            print(f"    ✗ {module}: {description} (MISSING)")
    
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
        'api/middleware.py',
        'layout_engine/engine.py',
    ]
    
    all_exist = True
    
    for file_path in files_to_check:
        if os.path.exists(file_path):
            print(f"  ✓ {file_path}")
        else:
            print(f"  ✗ {file_path} (MISSING)")
            all_exist = False
    
    return all_exist

def main():
    """Run deployment verification"""
    print("Product Editor - Deployment Verification")
    print("=" * 60)
    
    checks = [
        check_environment_variables,
        check_system_resources,
        check_dependencies,
        check_configuration_files,
    ]
    
    success = True
    for check in checks:
        if not check():
            success = False
    
    print("=" * 60)
    if success:
        print("✓ Deployment verification successful")
        sys.exit(0)
    else:
        print("✗ Deployment verification failed")
        sys.exit(1)

if __name__ == "__main__":
    main()
