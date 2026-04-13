#!/usr/bin/env python3
"""
Production Startup Script for Product Editor
Handles system verification, configuration, and startup
"""
import os
import sys
import subprocess
from pathlib import Path

def check_python_version():
    """Check Python version compatibility"""
    if sys.version_info < (3, 8):
        print("❌ Python 3.8+ required")
        return False
    print(f"✅ Python {sys.version_info.major}.{sys.version_info.minor}")
    return True

def check_dependencies():
    """Check required dependencies"""
    # Maps PyPI distribution name -> actual import name. Naive
    # `name.replace('-', '_')` is wrong for several common packages
    # (djangorestframework -> rest_framework, django-cors-headers -> corsheaders),
    # which would otherwise produce false "missing dependency" reports.
    required_packages = {
        'django': 'django',
        'djangorestframework': 'rest_framework',
        'django-cors-headers': 'corsheaders',
        'pillow': 'PIL',
    }

    print("Checking dependencies...")

    missing_required = []

    for package, import_name in required_packages.items():
        try:
            __import__(import_name)
            print(f"  ✅ {package}")
        except ImportError:
            print(f"  ❌ {package} (REQUIRED)")
            missing_required.append(package)
    
    if missing_required:
        print(f"\n❌ Missing required packages: {', '.join(missing_required)}")
        print("Install with: pip install " + " ".join(missing_required))
        return False
    
    return True

def check_database():
    """Check database connectivity"""
    print("\nChecking database...")
    
    try:
        os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'product_editor.settings')
        
        import django
        django.setup()
        
        from django.db import connection
        cursor = connection.cursor()
        cursor.execute("SELECT 1")
        
        print("  ✅ Database connection successful")
        return True
        
    except Exception as e:
        print(f"  ❌ Database connection failed: {e}")
        print("  Run: python manage.py migrate")
        return False

def run_migrations():
    """Run database migrations"""
    print("\nRunning database migrations...")
    
    try:
        result = subprocess.run([
            sys.executable, 'manage.py', 'migrate'
        ], capture_output=True, text=True, timeout=60)
        
        if result.returncode == 0:
            print("  ✅ Migrations completed successfully")
            return True
        else:
            print(f"  ❌ Migration failed: {result.stderr}")
            return False
            
    except subprocess.TimeoutExpired:
        print("  ❌ Migration timed out")
        return False
    except Exception as e:
        print(f"  ❌ Migration error: {e}")
        return False

def collect_static_files():
    """Collect static files for production"""
    print("\nCollecting static files...")
    
    try:
        result = subprocess.run([
            sys.executable, 'manage.py', 'collectstatic', '--noinput'
        ], capture_output=True, text=True, timeout=60)
        
        if result.returncode == 0:
            print("  ✅ Static files collected")
            return True
        else:
            print(f"  ⚠️  Static files collection warning: {result.stderr}")
            return True  # Non-critical for API-only deployment
            
    except Exception as e:
        print(f"  ⚠️  Static files collection error: {e}")
        return True  # Non-critical

def start_server(mode='development'):
    """Start the server"""
    print(f"\nStarting server in {mode} mode...")
    
    if mode == 'development':
        try:
            subprocess.run([
                sys.executable, 'manage.py', 'runserver', '0.0.0.0:8000'
            ])
        except KeyboardInterrupt:
            print("\n👋 Server stopped")
    
    elif mode == 'production':
        print("For production, use a WSGI server like Gunicorn:")
        print("gunicorn --workers 3 --bind 0.0.0.0:8000 product_editor.wsgi:application")
    
    return True

def main():
    """Main startup function"""
    print("🚀 Product Editor - Production Startup")
    print("=" * 60)
    
    # Check system requirements
    if not check_python_version():
        sys.exit(1)
    
    if not check_dependencies():
        sys.exit(1)
    
    # Database setup
    if not check_database():
        print("\nAttempting to run migrations...")
        if not run_migrations():
            print("❌ Database setup failed")
            sys.exit(1)
    
    # Static files (for production)
    collect_static_files()
    
    # Determine mode
    mode = 'production' if os.getenv('DJANGO_SETTINGS_MODULE', '').endswith('production') else 'development'
    
    print(f"\n✅ System ready for {mode} deployment!")
    
    # Show next steps
    if mode == 'development':
        print("\nStarting development server...")
        start_server('development')
    else:
        print("\nFor production deployment:")
        print("1. Configure Nginx/Apache")
        print("2. Set up Gunicorn/uWSGI")
        print("3. Configure SSL certificates")
        print("4. Set up monitoring")

if __name__ == "__main__":
    main()
