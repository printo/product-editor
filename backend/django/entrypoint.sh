#!/usr/bin/env sh
set -e

# Run migrations
/opt/venv/bin/python manage.py migrate --noinput

# Load API keys
/opt/venv/bin/python - <<'PY'
import os
import django
django.setup()

from api.models import APIKey

# Get API keys from environment variables
direct_key = os.getenv("DIRECT_API_KEY")
external_key = os.getenv("EXTERNAL_API_KEY")
test_key = os.getenv("TESTING_API_KEY")

# Create DIRECT API key from env
if direct_key and not APIKey.objects.filter(key=direct_key).exists():
    APIKey.objects.create(
        name="DIRECT",
        key=direct_key,
        description="Direct Ops Team API key",
        is_active=True,
        is_ops_team=True,
        can_generate_layouts=True,
        can_list_layouts=True,
        can_access_exports=True,
        max_requests_per_day=10000
    )
    print(f"✓ DIRECT API key loaded from environment")

# Create EXTERNAL API key from env
if external_key and not APIKey.objects.filter(key=external_key).exists():
    APIKey.objects.create(
        name="EXTERNAL",
        key=external_key,
        description="External Partner API key",
        is_active=True,
        is_ops_team=False,
        can_generate_layouts=True,
        can_list_layouts=True,
        can_access_exports=True,
        max_requests_per_day=1000
    )
    print(f"✓ EXTERNAL API key loaded from environment")

# Create TESTING API key from env
if test_key and not APIKey.objects.filter(key=test_key).exists():
    APIKey.objects.create(
        name="TESTING",
        key=test_key,
        description="Testing API key",
        is_active=True,
        is_ops_team=False,
        can_generate_layouts=True,
        can_list_layouts=True,
        can_access_exports=True,
        max_requests_per_day=5000
    )
    print(f"✓ TESTING API key loaded from environment")

# Show available API keys
print("\n🔑 Available API Keys:")
for key in APIKey.objects.filter(is_active=True):
    print(f"   {key.name}: {key.key}")

PY

exec "$@"
