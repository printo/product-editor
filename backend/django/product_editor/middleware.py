import os
from django.http import HttpResponseForbidden
from django.utils.deprecation import MiddlewareMixin

from product_editor.admin_sso import ADMIN_PATH_PREFIX


class ProxyAuthenticationMiddleware(MiddlewareMixin):
    """
    Ensure the Django admin is reached only via the edge proxy (nginx), never
    via a direct hit on backend:8000. nginx sets X-Forwarded-Proto and
    X-Forwarded-Host on every upstream request; their absence in production
    means someone is bypassing the proxy.

    **The prefix matters.** This guarded `/admin/` until 2026-09-04, while the
    admin has been mounted at `/django-admin/` since the initial commit (see
    product_editor/urls.py) — so it matched nothing and the bypass check had
    never once run. It became load-bearing when admin SSO landed: nginx's
    auth_request is what establishes the operator's identity, so a request that
    skipped nginx must not reach the admin at all. The signature check in
    admin_sso.py is the real defence (a forged identity fails without the
    shared secret); this is the cheap outer layer.
    """

    def process_request(self, request):
        # Check if this is an admin request
        if request.path.startswith(ADMIN_PATH_PREFIX):
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
