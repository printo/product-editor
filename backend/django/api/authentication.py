import requests
import os
import logging
from rest_framework import authentication, exceptions
from django.conf import settings
from .models import APIKey

logger = logging.getLogger(__name__)


class BearerTokenAuthentication(authentication.BaseAuthentication):
    """
    Custom authentication class for bearer token validation.
    Validates API keys against the database.
    """
    
    def authenticate(self, request):
        auth_header = request.META.get('HTTP_AUTHORIZATION', '')
        
        if not auth_header:
            return None
        
        try:
            auth_type, token = auth_header.split()
            if auth_type.lower() != 'bearer':
                return None
        except ValueError:
            return None
        
        try:
            api_key = APIKey.objects.get(key=token, is_active=True)
            
            from django.utils import timezone
            api_key.last_used_at = timezone.now()
            api_key.save(update_fields=['last_used_at'])
            
            logger.info(f"API Key authenticated: {api_key.name}")
            return (APIKeyUser(api_key), token)
            
        except APIKey.DoesNotExist:
            return None  # Let other authentication classes try
        except Exception as e:
            logger.error(f"Authentication error: {str(e)}")
            raise exceptions.AuthenticationFailed('Authentication failed.')


class PIAAuthentication(authentication.BaseAuthentication):
    """
    Custom authentication class for PIA token validation.
    Verifies tokens against the PIA service.
    """
    def authenticate(self, request):
        auth_header = request.META.get('HTTP_AUTHORIZATION')
        token = None
        
        if not auth_header:
            # Check cookies for access token (useful for browser-based requests)
            token = request.COOKIES.get('access')
            if not token:
                return None
        else:
            try:
                token_type, token_val = auth_header.split()
                if token_type.lower() != 'bearer':
                    return None
                token = token_val
            except ValueError:
                return None

        # Verify with PIA Service
        pia_base_url = os.getenv('PIA_API_BASE_URL', 'https://pia.printo.in/api/v1')
        verify_url = f"{pia_base_url}/auth/token-verify/"
        
        import hashlib
        from django.core.cache import cache
        cache_key = f"auth_token_{hashlib.sha256(token.encode()).hexdigest()[:32]}"
        
        # Check Cache first
        cached_user_data = cache.get(cache_key)
        if cached_user_data:
            return (PIAUser(cached_user_data), token)
        
        try:
            # connect timeout=2s (fail fast if PIA unreachable), read timeout=5s
            response = requests.post(
                verify_url,
                json={'token': token},
                timeout=(2, 5),
            )
            if response.status_code == 200:
                user_data = response.json()
                # Cache for 30 mins so subsequent requests skip this network call entirely
                cache.set(cache_key, user_data, 1800)
                return (PIAUser(user_data), token)
            else:
                logger.warning(f"PIA token verification failed: {response.status_code}")
                return None
        except Exception as e:
            logger.error(f"PIA Auth service error: {str(e)}")
            return None


class APIKeyUser:
    def __init__(self, api_key: APIKey):
        self.api_key = api_key
        self.is_authenticated = True
        self.is_anonymous = False
        self.is_active = api_key.is_active
        self.id = api_key.id
        self.username = api_key.name
        self.email = api_key.user.email if api_key.user else None
        self.is_staff = False
        self.is_superuser = False
        self.is_ops_team = getattr(api_key, 'is_ops_team', False)
        self.auth_source = api_key.name # "DIRECT", "EXTERNAL", etc.

    def __str__(self):
        return f"APIKey({self.api_key.name})"
    
    @property
    def pk(self):
        return self.api_key.id


class PIAUser:
    def __init__(self, data):
        self.is_authenticated = True
        self.is_anonymous = False
        self.is_active = True
        self.id = data.get('id')
        self.username = data.get('username') or data.get('email')
        self.email = data.get('email')
        self.is_staff = data.get('is_super_user', False)
        self.is_superuser = data.get('is_super_user', False)
        self.is_ops_team = data.get('is_ops_team', False)
        self.full_name = data.get('full_name') or data.get('username') or data.get('email')
        self.empid = data.get('user_id') or data.get('id')  # Numeric PIA user/employee ID
        self.auth_source = "PIA"

    def __str__(self):
        return f"PIA({self.username})"

    @property
    def pk(self):
        return self.id
