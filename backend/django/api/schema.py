"""
drf-spectacular extensions — how the OpenAPI schema (and therefore the Scalar
reference at ``/docs/api/``) describes this project's custom authentication.

Both authenticators in ``api.authentication`` are hand-rolled subclasses of
DRF's ``BaseAuthentication``. drf-spectacular can only introspect the classes it
ships extensions for, so without the two below it emitted
``could not resolve authenticator ... Ignoring for now`` for every view and
produced a document whose operations referenced a ``BearerAuth`` scheme that was
never defined under ``components.securitySchemes`` — invalid OpenAPI, and no
Authorize button in Scalar.

(The previous attempt at this lived in ``settings.SPECTACULAR_SETTINGS`` as
``SECURITY_DEFINITIONS``. That is a **drf-yasg** setting name; drf-spectacular
has no such key and ignored it silently, which is why the omission went
unnoticed. Registering extensions is the supported route.)

Imported from ``ApiConfig.ready()`` — an extension only registers when its
module is imported.
"""
import re

from drf_spectacular.extensions import OpenApiAuthenticationExtension
from drf_spectacular.openapi import AutoSchema


class ProductEditorAutoSchema(AutoSchema):
    """
    Gives collection and detail routes of the same view distinct operationIds.

    drf-spectacular tokenizes a path for the operationId with **every path
    variable stripped**, so a view mounted at both ``/api/ops/layouts`` and
    ``/api/ops/layouts/{name}`` produces the identical id twice. It then
    disambiguates the duplicate with a numeral suffix — ``ops_layouts_retrieve``
    and ``ops_layouts_retrieve_2`` — whose assignment depends on traversal
    order, so which route is "_2" is not stable and neither name says anything
    about the route it belongs to.

    Ten operations across four double-mounted views hit this. Naming the detail
    variant after the parameter that actually distinguishes it
    (``ops_layouts_by_name_retrieve``) is stable, self-describing, and removes
    the warnings rather than silencing them.
    """

    def get_operation_id(self) -> str:
        operation_id = super().get_operation_id()
        trailing_param = re.search(r'\{([\w-]+)\}/?$', self.path)
        if not trailing_param:
            return operation_id
        param = trailing_param.group(1).replace('-', '_')

        # Recompute the action exactly as the parent does, rather than splitting
        # it off the tail — "partial_update" is two tokens and a naive rsplit
        # would cut it in half.
        if self.method == 'GET' and self._is_list_view():
            action = 'list'
        else:
            action = self.method_mapping[self.method.lower()]

        suffix = f'_{action}'
        if operation_id.endswith(suffix):
            return f'{operation_id[: -len(suffix)]}_by_{param}{suffix}'
        return f'{operation_id}_by_{param}'



class BearerTokenAuthenticationScheme(OpenApiAuthenticationExtension):
    """`Authorization: Bearer <api-key>` — a row in the APIKey table."""

    target_class = "api.authentication.BearerTokenAuthentication"
    name = "BearerAuth"

    def get_security_definition(self, auto_schema):
        return {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "API key",
            "description": (
                "Server-to-server API key, issued by Printo ops and stored in the "
                "`APIKey` table.\n\n"
                "```\nAuthorization: Bearer <api-key>\n```\n\n"
                "Never place this key in a URL or ship it to a browser. Customer-facing "
                "iframes exchange it for a short-lived embed token first — see "
                "`POST /api/embed/session`."
            ),
        }


class PIAAuthenticationScheme(OpenApiAuthenticationExtension):
    """PIA staff session — `Authorization: Bearer <pia-jwt>` **or** the `access` cookie."""

    target_class = "api.authentication.PIAAuthentication"
    name = ["PIAAuth", "PIASessionCookie"]

    def get_security_requirement(self, auto_schema):
        # A list of dicts is OR in OpenAPI; a single dict with two keys would be
        # AND. Either credential alone authenticates, so this must stay a list.
        return [{"PIAAuth": []}, {"PIASessionCookie": []}]

    def get_security_definition(self, auto_schema):
        return [
            {
                "type": "http",
                "scheme": "bearer",
                "bearerFormat": "PIA JWT",
                "description": (
                    "Access token issued by PIA (`PIA_API_BASE_URL`) for a logged-in "
                    "Printo staff member. Verified upstream on first use, then cached "
                    "for 30 minutes.\n\n"
                    "```\nAuthorization: Bearer <pia-access-token>\n```"
                ),
            },
            {
                "type": "apiKey",
                "in": "cookie",
                "name": "access",
                "description": (
                    "The same PIA access token read from an `access` cookie instead of "
                    "the header, for browser-originated requests."
                ),
            },
        ]
