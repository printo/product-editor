from rest_framework.permissions import BasePermission
from rest_framework.exceptions import PermissionDenied
from .authentication import APIKeyUser, PIAUser


class IsAuthenticatedWithAPIKey(BasePermission):
    """
    Permission class that requires API key authentication.
    Also allows Django admin users (for development).
    """
    
    def has_permission(self, request, view):
        user = getattr(request, 'user', None)
        
        # Allow Django admin users
        if user and hasattr(user, 'is_staff') and user.is_staff:
            return True
        
        # Allow authenticated API key users
        if isinstance(user, APIKeyUser) and user.is_authenticated:
            return True
            
        # Allow authenticated PIA users
        if isinstance(user, PIAUser) and user.is_authenticated:
            return True
        
        return False


class CanGenerateLayouts(BasePermission):
    """Permission class to check if API key can generate layouts."""
    
    def has_permission(self, request, view):
        user = getattr(request, 'user', None)
        
        # Admin users always allowed
        if user and hasattr(user, 'is_staff') and user.is_staff:
            return True
        
        # Check API key permissions
        if isinstance(user, APIKeyUser):
            if not user.api_key.can_generate_layouts:
                raise PermissionDenied(
                    "This API key does not have permission to generate layouts."
                )
            return True
        
        return False


class CanListLayouts(BasePermission):
    """Permission class to check if API key can list layouts."""
    
    def has_permission(self, request, view):
        user = getattr(request, 'user', None)
        
        # Admin users always allowed
        if user and hasattr(user, 'is_staff') and user.is_staff:
            return True
        
        # Allow PIAUsers (dashboard/editor users)
        if isinstance(user, PIAUser):
            return True
            
        # Check API key permissions
        if isinstance(user, APIKeyUser):
            if not user.api_key.can_list_layouts:
                raise PermissionDenied(
                    "This API key does not have permission to list layouts."
                )
            return True
        
        return False


class CanAccessExports(BasePermission):
    """Permission class to check if API key can access exports."""
    
    def has_permission(self, request, view):
        user = getattr(request, 'user', None)
        
        # Admin users always allowed
        if user and hasattr(user, 'is_staff') and user.is_staff:
            return True
        
        # Allow PIAUsers
        if isinstance(user, PIAUser):
            return True
            
        # Check API key permissions
        if isinstance(user, APIKeyUser):
            if not user.api_key.can_access_exports:
                raise PermissionDenied(
                    "This API key does not have permission to access exports."
                )
            return True
        
        return False


class IsOpsTeam(BasePermission):
    """Permission class to check if API key belongs to the internal operations team."""
    
    def has_permission(self, request, view):
        user = getattr(request, 'user', None)
        
        # Admin users always allowed
        if user and hasattr(user, 'is_staff') and user.is_staff:
            return True
        
        # Check PIA User role
        if isinstance(user, PIAUser):
            if not getattr(user, 'is_ops_team', False):
                raise PermissionDenied(
                    "This action requires internal operations team permissions."
                )
            return True

        # Check API key role
        if isinstance(user, APIKeyUser):
            if not user.api_key.is_ops_team:
                raise PermissionDenied(
                    "This action requires internal operations team permissions."
                )
            return True
        
        return False

