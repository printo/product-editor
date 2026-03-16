import os
from django.http import HttpResponseForbidden
from django.utils.deprecation import MiddlewareMixin


class ProxyAuthenticationMiddleware(MiddlewareMixin):
    """
    Middleware to ensure admin access only comes through the Traefik proxy.
    Blocks direct localhost access attempts to /admin/django-admin/
    """

    def process_request(self, request):
        # Check if this is an admin request
        if request.path.startswith("/admin/"):
            # In production, require X-Forwarded-Proto header from proxy
            if os.getenv("DEBUG", "1") == "0":  # Production mode
                forwarded_proto = request.META.get("HTTP_X_FORWARDED_PROTO")
                forwarded_host = request.META.get("HTTP_X_FORWARDED_HOST")

                # Reject if not coming through proxy
                if not forwarded_proto or not forwarded_host:
                    return HttpResponseForbidden(
                        "Admin access must be through the proxy. Direct access is not allowed."
                    )

                # Only allow HTTPS in production
                if forwarded_proto != "https":
                    return HttpResponseForbidden("Admin access requires HTTPS.")

        return None
