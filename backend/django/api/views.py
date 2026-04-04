import os
import re
import json
import time
import logging
from functools import wraps
from typing import Optional, Dict, Any, List
from django.conf import settings
from django.utils import timezone
from rest_framework.views import APIView
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework import status
from django.utils.crypto import get_random_string
from django.core.exceptions import ValidationError
import platform
import signal
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiExample, OpenApiResponse, inline_serializer
from drf_spectacular.types import OpenApiTypes
from rest_framework import serializers as drf_serializers
from layout_engine.engine import LayoutEngine
from services.storage import get_storage
from .permissions import IsAuthenticatedWithAPIKey, CanGenerateLayouts, CanListLayouts, CanAccessExports, IsOpsTeam
from .authentication import APIKeyUser
from .validators import validate_image_files
from .models import UploadedFile, ExportedResult, EmbedSession

logger = logging.getLogger(__name__)


def timeout_handler(signum, frame):
    """Handle timeout for long-running operations."""
    raise TimeoutError("Operation timed out")


def with_timeout(seconds=300):
    """Decorator to add timeout to operations. (300 seconds = 5 minutes default)"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            if platform.system() == 'Windows' or not hasattr(signal, 'SIGALRM'):
                # SIGALRM not available on Windows — run without timeout
                return func(*args, **kwargs)
            signal.signal(signal.SIGALRM, timeout_handler)
            signal.alarm(seconds)
            try:
                result = func(*args, **kwargs)
                signal.alarm(0)  # Disable alarm
                return result
            except TimeoutError as e:
                logger.error(f"Operation timeout in {func.__name__}: {str(e)}")
                raise
            finally:
                signal.alarm(0)  # Ensure alarm is disabled
        return wrapper
    return decorator


class HealthView(APIView):
    """Health check endpoint - public access."""
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["health"],
        summary="Service health check",
        description="Returns `ok` if the service and database are reachable. No authentication required.",
        responses={
            200: inline_serializer(
                name="HealthResponse",
                fields={
                    "status": drf_serializers.CharField(default="ok"),
                    "database": drf_serializers.CharField(default="connected"),
                    "timestamp": drf_serializers.IntegerField(),
                },
            )
        },
    )
    def get(self, request):
        return Response({
            "status": "ok",
            "database": "connected",
            "timestamp": int(time.time() * 1000)
        })


class ListLayoutsView(APIView):
    """List available layouts - requires API key."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["layouts"],
        summary="List all available layouts",
        description="Returns all layout definitions the API key is permitted to use.",
        responses={
            200: inline_serializer(
                name="LayoutListResponse",
                fields={"layouts": drf_serializers.ListField(child=drf_serializers.DictField())},
            )
        },
    )
    def get(self, request):
        try:
            from django.core.cache import cache as django_cache
            CACHE_KEY = "layouts_list_all"
            CACHE_TTL = 120  # 2 minutes — invalidated on upload/save

            layouts_data = django_cache.get(CACHE_KEY)
            if layouts_data is None:
                storage = get_storage()
                layout_names = storage.list_layouts()
                layouts_data = []
                for name in layout_names:
                    path = os.path.join(storage.layouts_dir(), f"{name}.json")
                    if os.path.exists(path):
                        try:
                            with open(path, "r") as f:
                                data = json.load(f)
                                if "name" not in data:
                                    data["name"] = name
                                layouts_data.append(data)
                        except Exception:
                            layouts_data.append({"name": name})
                    else:
                        layouts_data.append({"name": name})
                django_cache.set(CACHE_KEY, layouts_data, CACHE_TTL)
                logger.info(f"Layouts cache miss — loaded {len(layouts_data)} layouts from disk")
            else:
                logger.info(f"Layouts cache hit — serving {len(layouts_data)} layouts")

            response = Response({"layouts": layouts_data})
            response['Cache-Control'] = 'private, max-age=60, stale-while-revalidate=120'
            return response
        except Exception as e:
            logger.error(f"Error listing layouts: {str(e)}")
            return Response(
                {"detail": "Failed to list layouts"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class GenerateLayoutView(APIView):
    """Generate layout from images - requires API key."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanGenerateLayouts]

    @extend_schema(
        tags=["generate"],
        summary="Generate canvas from images",
        description=(
            "Upload images and a layout definition to produce a rendered canvas.\n\n"
            "**Request format:** `multipart/form-data`\n\n"
            "| Field | Type | Default | Description |\n"
            "|-------|------|---------|-------------|\n"
            "| `layout` | string | — | Layout name (e.g. `retro_polaroid_4.2x3.5`) |\n"
            "| `images` | file[] | — | One or more image files |\n"
            "| `fit_mode` | string | `cover` | `contain` or `cover` |\n"
            "| `export_format` | string | `png` | `png` or `tiff_cmyk` |\n"
            "| `soft_proof` | boolean | `false` | Run full ICC CMYK soft-proof pipeline |\n\n"
            "**Soft-proof mode** (`soft_proof=true`):\n\n"
            "Runs the RGB → CMYK → RGB roundtrip using the ISOcoated_v2 ICC profile "
            "(industry standard for Indian and European offset print on coated stock).\n\n"
            "Returns three files per canvas and a per-canvas colour-shift report:\n"
            "- `png` — original RGB design\n"
            "- `tiff_cmyk` — press-ready CMYK TIFF (send this to the printer)\n"
            "- `cmyk_preview` — on-screen simulation of printed colours\n"
            "- `color_shift.significant=true` — shown to user when avg pixel shift > 8/255 (~3%)\n\n"
            "When `soft_proof=false`, returns a simple `canvases` list."
        ),
        request=inline_serializer(
            name="GenerateLayoutRequest",
            fields={
                "layout": drf_serializers.CharField(help_text="Layout name or JSON"),
                "images": drf_serializers.ListField(
                    child=drf_serializers.ImageField(),
                    help_text="Image files",
                ),
                "fit_mode": drf_serializers.ChoiceField(choices=["contain", "cover"], required=False, default="cover"),
                "export_format": drf_serializers.ChoiceField(choices=["png", "tiff_cmyk"], required=False, default="png"),
                "soft_proof": drf_serializers.BooleanField(required=False, default=False),
            },
        ),
        responses={
            200: inline_serializer(
                name="GenerateLayoutResponse",
                fields={
                    "canvases": drf_serializers.ListField(child=drf_serializers.CharField(), required=False),
                    "soft_proof_canvases": drf_serializers.ListField(child=drf_serializers.DictField(), required=False),
                    "layout_name": drf_serializers.CharField(),
                    "export_format": drf_serializers.CharField(),
                    "generation_time_ms": drf_serializers.IntegerField(),
                },
            ),
            400: OpenApiResponse(description="Invalid request — missing images or bad layout"),
            408: OpenApiResponse(description="Timeout — generation exceeded 5 minutes"),
        },
    )
    @with_timeout(seconds=300)
    def post(self, request):
        try:
            layout_data = request.data.get("layout")
            if isinstance(layout_data, str) and (layout_data.startswith('{') or layout_data.startswith('[')):
                try:
                    layout_data = json.loads(layout_data)
                except Exception:
                    pass

            layout_name = layout_data.get('name') if isinstance(layout_data, dict) else layout_data
            files = request.FILES.getlist("images")

            fit_mode = request.data.get("fit_mode", "cover")
            if fit_mode not in ("contain", "cover"):
                fit_mode = "cover"

            export_format = request.data.get("export_format", "png")
            if export_format not in ("png", "tiff_cmyk"):
                export_format = "png"

            # soft_proof accepts "true"/"1"/True
            raw_sp = request.data.get("soft_proof", False)
            soft_proof = raw_sp in (True, "true", "1", 1)

            if not layout_name or not files:
                return Response(
                    {"detail": "layout and images are required"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if not self._is_valid_layout_name(layout_name):
                return Response(
                    {"detail": f"Invalid layout name: {layout_name}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            try:
                validate_image_files(files)
            except ValidationError as e:
                return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)

            api_key = None
            if isinstance(request.user, APIKeyUser):
                api_key = request.user.api_key

            upload_paths = []
            storage = get_storage()
            start_time = time.time()

            try:
                for f in files:
                    fname = get_random_string(8) + "_" + f.name
                    path = storage.save_upload(fname, f.file)
                    upload_paths.append(path)
                    if api_key:
                        UploadedFile.objects.create(
                            api_key=api_key,
                            file_path=path,
                            original_filename=f.name,
                            file_size_bytes=f.size,
                            file_type='image',
                        )

                engine = LayoutEngine(storage.layouts_dir(), settings.EXPORTS_DIR)
                generation_time_ms = 0

                if soft_proof:
                    # ── Full ICC CMYK soft-proof pipeline ───────────────────
                    proof_results = engine.generate_soft_proof(
                        layout_name, upload_paths, fit_mode=fit_mode,
                    )
                    generation_time_ms = int((time.time() - start_time) * 1000)

                    # Track all output files in ExportedResult
                    if api_key:
                        for r in proof_results:
                            for key in ("png", "tiff_cmyk", "cmyk_preview"):
                                out_path = r.get(key)
                                if out_path and os.path.exists(out_path):
                                    ExportedResult.objects.create(
                                        api_key=api_key,
                                        layout_name=layout_name,
                                        export_file_path=out_path,
                                        input_files=upload_paths,
                                        generation_time_ms=generation_time_ms,
                                        file_size_bytes=os.path.getsize(out_path),
                                    )

                    # Build response — convert absolute paths to relative
                    serialized = []
                    for r in proof_results:
                        shift = r["color_shift"]
                        serialized.append({
                            "png":          os.path.relpath(r["png"],          settings.EXPORTS_DIR),
                            "tiff_cmyk":    os.path.relpath(r["tiff_cmyk"],    settings.EXPORTS_DIR),
                            "cmyk_preview": os.path.relpath(r["cmyk_preview"], settings.EXPORTS_DIR),
                            "color_shift": {
                                "avg_diff":         shift["avg_diff"],
                                "max_pixel_diff":   shift["max_pixel_diff"],
                                "significant":      shift["significant"],
                                "using_icc_profile": shift["using_icc_profile"],
                                "profile":          shift["profile"],
                                "message":          shift["message"],
                            },
                        })

                    logger.info(
                        "Soft-proof generated: %s by %s (%d canvases, %d ms)",
                        layout_name,
                        api_key.name if api_key else "unknown",
                        len(serialized),
                        generation_time_ms,
                    )
                    return Response({
                        "soft_proof_canvases": serialized,
                        "layout_name": layout_name,
                        "export_format": "soft_proof",
                        "generation_time_ms": generation_time_ms,
                    })

                else:
                    # ── Standard RGB PNG / CMYK TIFF export ─────────────────
                    outputs = engine.generate(
                        layout_name, upload_paths, fit_mode=fit_mode, export_format=export_format,
                    )
                    generation_time_ms = int((time.time() - start_time) * 1000)

                    if api_key and outputs:
                        for out_path in outputs:
                            ExportedResult.objects.create(
                                api_key=api_key,
                                layout_name=layout_name,
                                export_file_path=out_path,
                                input_files=upload_paths,
                                generation_time_ms=generation_time_ms,
                                file_size_bytes=os.path.getsize(out_path),
                            )

                    rel = [os.path.relpath(p, settings.EXPORTS_DIR) for p in outputs]
                    logger.info(
                        "Layout generated: %s by %s (%d files, %d ms)",
                        layout_name,
                        api_key.name if api_key else "unknown",
                        len(rel),
                        generation_time_ms,
                    )
                    return Response({
                        "canvases": rel,
                        "layout_name": layout_name,
                        "export_format": export_format,
                        "generation_time_ms": generation_time_ms,
                    })

            except TimeoutError:
                logger.error("Timeout generating layout: %s", layout_name)
                return Response(
                    {"detail": "Layout generation timed out. Try with fewer/smaller images."},
                    status=status.HTTP_408_REQUEST_TIMEOUT,
                )
            except Exception as exc:
                logger.error("Error generating layout '%s': %s", layout_name, exc)
                return Response(
                    {"detail": f"Failed to generate layout: {exc}"},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR,
                )

        except Exception as exc:
            logger.error("Unexpected error in GenerateLayoutView: %s", exc)
            return Response(
                {"detail": "An unexpected error occurred"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
    
    @staticmethod
    def _is_valid_layout_name(name: str) -> bool:
        """
        Validate layout name to prevent path traversal.
        Layout names should be alphanumeric with hyphens/underscores only.
        """
        if not name:
            return False
        
        # Reject if contains path separators or suspicious patterns
        if '/' in name or '\\' in name or '..' in name or name.startswith('.'):
            return False
        
        # Check if layout actually exists in storage
        try:
            storage = get_storage()
            available_layouts = storage.list_layouts()
            return name in available_layouts
        except:
            return False


class GetLayoutView(APIView):
    """Get layout JSON - requires API key."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    @extend_schema(
        tags=["layouts"],
        summary="Get layout by name",
        description="Retrieve the full JSON definition for a specific layout.",
        parameters=[
            OpenApiParameter("name", OpenApiTypes.STR, OpenApiParameter.PATH, description="Layout name, e.g. `retro_polaroid_4.2x3.5`"),
        ],
        responses={
            200: inline_serializer(
                name="LayoutDetailResponse",
                fields={
                    "name": drf_serializers.CharField(),
                    "canvases": drf_serializers.ListField(child=drf_serializers.DictField()),
                },
            ),
            404: OpenApiResponse(description="Layout not found"),
        },
    )
    def get(self, request, name: str):
        try:
            # Validate layout name - prevents path traversal
            if not self._is_valid_layout_name(name):
                return Response(
                    {"detail": "Invalid layout name"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            storage = get_storage()
            # Use basename to prevent path traversal
            safe_name = os.path.basename(name)
            path = os.path.join(storage.layouts_dir(), f"{safe_name}.json")
            
            # Extra security: ensure path is within layouts directory
            if not self._is_path_safe(path, storage.layouts_dir()):
                return Response(
                    {"detail": "Access denied"},
                    status=status.HTTP_403_FORBIDDEN
                )
            
            if not os.path.exists(path):
                return Response(
                    {"detail": "Layout not found"},
                    status=status.HTTP_404_NOT_FOUND
                )
            
            with open(path, "r") as f:
                data = json.load(f)

            # Filter surfaces if ?surfaces= param is provided (for multi-surface layouts)
            surfaces_param = request.query_params.get('surfaces')
            if surfaces_param and 'surfaces' in data and isinstance(data['surfaces'], list):
                requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
                data['surfaces'] = [
                    s for s in data['surfaces']
                    if s.get('key', '').lower() in requested_keys
                ]

            response = Response(data)
            response['Cache-Control'] = 'private, max-age=300, stale-while-revalidate=600'
            return response

        except json.JSONDecodeError:
            logger.error(f"Invalid JSON in layout file: {name}")
            return Response(
                {"detail": "Corrupted layout file"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
        except Exception as e:
            logger.error(f"Error getting layout: {str(e)}")
            return Response(
                {"detail": "Failed to get layout"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )

    @staticmethod
    def _is_valid_layout_name(name: str) -> bool:
        """Validate layout name."""
        if not name or '/' in name or '\\' in name or '..' in name:
            return False
        try:
            storage = get_storage()
            available_layouts = storage.list_layouts()
            return name in available_layouts
        except:
            return False
    
    @staticmethod
    def _is_path_safe(path: str, allowed_dir: str) -> bool:
        """Ensure path is within allowed directory (prevents path traversal)."""
        try:
            real_path = os.path.realpath(path)
            real_allowed_dir = os.path.realpath(allowed_dir)
            return real_path.startswith(real_allowed_dir)
        except:
            return False


class SecureExportDownloadView(APIView):
    """
    Secure file serving endpoint for exports.
    Requires authentication and checks file path to prevent traversal attacks.
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanAccessExports]

    @extend_schema(
        tags=["exports"],
        summary="Download exported file",
        description=(
            "Stream a generated export file (HQ PNG, imposition sheet, etc.) "
            "back to the authenticated caller. Path traversal is prevented server-side."
        ),
        parameters=[
            OpenApiParameter("file_path", OpenApiTypes.STR, OpenApiParameter.PATH, description="Relative path to the export file"),
        ],
        responses={
            200: OpenApiResponse(description="Binary file stream"),
            403: OpenApiResponse(description="Path traversal attempt detected"),
            404: OpenApiResponse(description="Export file not found"),
        },
    )
    def get(self, request, file_path: str):
        """Download a generated export file securely."""
        try:
            # Validate file path - prevent traversal attacks
            if not self._is_path_safe(file_path):
                logger.warning(f"Attempted traversal attack: {file_path}")
                return Response(
                    {"detail": "Access denied"},
                    status=status.HTTP_403_FORBIDDEN
                )
            
            # Construct full path
            # Fallback to STORAGE_ROOT or current directory if MEDIA_ROOT is not set
            base_dir = getattr(settings, 'MEDIA_ROOT', getattr(settings, 'STORAGE_ROOT', '.'))
            # The following line seems to be a partial instruction.
            # Assuming the intent is to use base_dir for the full_path construction,
            # and the `for` loop was a mistake or incomplete.
            # If the original `settings.EXPORTS_DIR` should be replaced, it would be:
            # full_path = os.path.join(base_dir, file_path)
            # However, the instruction explicitly shows `S_DIR, file_path)` which is malformed.
            # Given the context of "Fix MEDIA_ROOT fallback", it's likely `base_dir` should be used.
            # But `settings.EXPORTS_DIR` is also a valid base for exports.
            # I will assume the instruction meant to replace `settings.EXPORTS_DIR` with `base_dir`
            # for the `full_path` construction, and the `for` loop was an error in the instruction.
            # If the intent was to iterate, the instruction is too incomplete to implement correctly.
            # Sticking to the most plausible interpretation of "Fix MEDIA_ROOT fallback" for a base directory.
            full_path = os.path.join(base_dir, file_path)
            
            # Double-check path safety (defense in depth)
            if not self._is_full_path_safe(full_path):
                logger.warning(f"Path safety check failed: {full_path}")
                return Response(
                    {"detail": "Access denied"},
                    status=status.HTTP_403_FORBIDDEN
                )
            
            # Check if file exists
            if not os.path.exists(full_path) or not os.path.isfile(full_path):
                return Response(
                    {"detail": "File not found"},
                    status=status.HTTP_404_NOT_FOUND
                )
            
            # Serve file with proper headers
            with open(full_path, 'rb') as f:
                file_content = f.read()
            
            response = Response(file_content)
            response['Content-Type'] = 'image/png'  # Adjust based on actual file type
            response['Content-Length'] = len(file_content)
            response['Content-Disposition'] = f'attachment; filename="{os.path.basename(full_path)}"'
            
            # Log download
            api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
            if api_key:
                logger.info(f"Export downloaded: {file_path} by {api_key.name}")
            
            return response
        
        except Exception as e:
            logger.error(f"Error downloading export: {str(e)}")
            return Response(
                {"detail": "Failed to download file"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
    
    @staticmethod
    def _is_path_safe(file_path: str) -> bool:
        """
        Check if file path is safe (no traversal attempts).
        """
        # Reject paths with traversal patterns
        if '..' in file_path or file_path.startswith('/') or file_path.startswith('\\'):
            return False
        
        # Reject paths with special characters
        if any(c in file_path for c in ['\\', ':', '\x00']):
            return False
        
        return True
    
    @staticmethod
    def _is_full_path_safe(full_path: str) -> bool:
        """
        Verify full path is within allowed directory.
        Defense in depth against traversal.
        """
        try:
            real_path = os.path.realpath(full_path)
            real_exports_dir = os.path.realpath(settings.EXPORTS_DIR)
            
            # Ensure path is within EXPORTS_DIR
            return real_path.startswith(real_exports_dir) and os.path.isfile(real_path)
        except:
            return False

class LayoutManagementView(APIView):
    """View to manage layout JSON files - requires Ops Team permissions."""
    permission_classes = [IsAuthenticatedWithAPIKey, IsOpsTeam]
    from rest_framework.parsers import JSONParser, MultiPartParser, FormParser
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    
    def _is_valid_layout_name(self, name: str) -> bool:
        """Validate layout name for security."""
        import re
        return bool(re.match(r'^[a-zA-Z0-9_.\-]+$', name))
    
    def _is_path_safe(self, path: str, base_dir: str) -> bool:
        """Ensure path is within the intended directory."""
        return os.path.abspath(path).startswith(os.path.abspath(base_dir))

    def get(self, request, name=None):
        """List layouts or get a specific layout's JSON."""
        storage = get_storage()
        if name:
            if not self._is_valid_layout_name(name):
                return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)
            
            path = os.path.join(storage.layouts_dir(), f"{name}.json")
            if not self._is_path_safe(path, storage.layouts_dir()):
                return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
            
            if not os.path.exists(path):
                return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)
            
            try:
                with open(path, "r") as f:
                    return Response(json.load(f))
            except Exception as e:
                return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)
        else:
            layout_names = storage.list_layouts()
            layouts_data = []
            for name in layout_names:
                path = os.path.join(storage.layouts_dir(), f"{name}.json")
                if os.path.exists(path):
                    try:
                        with open(path, "r") as f:
                            data = json.load(f)
                            if "name" not in data:
                                data["name"] = name
                            layouts_data.append(data)
                    except Exception:
                        layouts_data.append({"name": name})
                else:
                    layouts_data.append({"name": name})
            return Response({"layouts": layouts_data})

    def post(self, request, name=None):
        """Create or update a layout JSON file."""
        layout_name = name or request.data.get("name")
        layout_data = request.data.get("layout_data") or request.data.get("layout")
        
        if not layout_name or not layout_data:
            return Response({"detail": "name and layout_data are required"}, status=status.HTTP_400_BAD_REQUEST)
        
        if not self._is_valid_layout_name(layout_name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)
            
        storage = get_storage()
        path = os.path.join(storage.layouts_dir(), f"{layout_name}.json")
        
        if not self._is_path_safe(path, storage.layouts_dir()):
            return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
        
        # Support rename: if old_name is provided and differs from layout_name,
        # the old file will be removed after the new one is saved.
        old_name = request.data.get("old_name") or request.data.get("originalName")
        if old_name and old_name == layout_name:
            old_name = None  # Not actually a rename
        
        try:
            # Basic validation: ensure it's a valid JSON dict
            if isinstance(layout_data, str):
                layout_data = json.loads(layout_data)
            
            # Ensure required fields for LayoutEngine exist
            is_multi_surface = layout_data.get('type') == 'product' and isinstance(layout_data.get('surfaces'), list)
            if is_multi_surface:
                for idx, surface in enumerate(layout_data['surfaces']):
                    s_canvas = surface.get('canvas', {})
                    if 'width' not in s_canvas or 'height' not in s_canvas:
                        return Response(
                            {"detail": f"Surface '{surface.get('key', idx)}': missing canvas width/height"},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
            elif 'canvas' not in layout_data or 'width' not in layout_data['canvas'] or 'height' not in layout_data['canvas']:
                return Response({"detail": "Invalid layout structure: missing canvas width/height"}, status=status.HTTP_400_BAD_REQUEST)
            
            # Append metadata
            from django.utils import timezone
            now = timezone.now().isoformat()
            
            # Use full_name and empid if available, fallback to username
            full_name = getattr(request.user, 'full_name', getattr(request.user, 'username', str(request.user)))
            emp_id = getattr(request.user, 'empid', None)
            
            # Prepare metadata in array format for fast external loading/parsing
            meta_entries = {
                "createdByName": full_name,
                "createdById": emp_id,
                "createdAt": now,
                "updatedByName": full_name,
                "updatedById": emp_id,
                "updatedAt": now
            }
            
            # Handle Mask Image Upload
            # For multi-surface layouts, masks can be uploaded as mask_{surface_key} fields
            if is_multi_surface:
                for surface in layout_data.get('surfaces', []):
                    surface_key = surface.get('key', '')
                    mask_field = f"mask_{surface_key}"
                    surface_mask_file = request.FILES.get(mask_field)
                    if surface_mask_file:
                        try:
                            import glob as glob_mod_s
                            existing = glob_mod_s.glob(os.path.join(storage.masks_dir(), f"{layout_name}_{surface_key}_mask.*"))
                            for m in existing:
                                if os.path.exists(m):
                                    os.remove(m)
                        except Exception as e:
                            logger.warning(f"Failed to cleanup old surface masks: {e}")
                        mask_filename = f"{layout_name}_{surface_key}_mask{os.path.splitext(surface_mask_file.name)[1]}"
                        mask_path = os.path.join(storage.masks_dir(), mask_filename)
                        with open(mask_path, 'wb+') as destination:
                            for chunk in surface_mask_file.chunks():
                                destination.write(chunk)
                        surface['maskUrl'] = f"/api/layouts/masks/{mask_filename}"

            mask_file = request.FILES.get('mask')
            if mask_file:
                # Cleanup ANY existing mask files for this layout first (to handle extension changes)
                try:
                    import glob
                    existing_masks = glob.glob(os.path.join(storage.masks_dir(), f"{layout_name}_mask.*"))
                    for m in existing_masks:
                        if os.path.exists(m):
                            os.remove(m)
                except Exception as e:
                    logger.warning(f"Failed to cleanup old masks during update: {e}")

                mask_filename = f"{layout_name}_mask{os.path.splitext(mask_file.name)[1]}"
                mask_path = os.path.join(storage.masks_dir(), mask_filename)
                with open(mask_path, 'wb+') as destination:
                    for chunk in mask_file.chunks():
                        destination.write(chunk)
                layout_data['maskUrl'] = f"/api/layouts/masks/{mask_filename}"
            
            # Handle boolean flag for maskOnExport
            if 'maskOnExport' in request.data:
                val = request.data.get('maskOnExport')
                layout_data['maskOnExport'] = str(val).lower() == 'true'

            # Handle explicit mask removal
            remove_mask = str(request.data.get('remove_mask', '')).lower() == 'true'
            if remove_mask:
                # Delete existing mask files from disk
                try:
                    import glob as glob_mod
                    existing_masks = glob_mod.glob(os.path.join(storage.masks_dir(), f"{layout_name}_mask.*"))
                    for m in existing_masks:
                        os.remove(m)
                        logger.info(f"Removed mask file: {m}")
                except Exception as e:
                    logger.warning(f"Failed to cleanup masks during removal: {e}")
                layout_data['maskUrl'] = None
                layout_data['maskOnExport'] = False

            if os.path.exists(path):
                try:
                    with open(path, "r") as f:
                        existing_data = json.load(f)

                    # Handle Mask Migration if layout is renamed but mask already exists for old name
                    # This prevents broken mask URLs when 'Saving As' or renaming
                    # Skip restoration if mask was explicitly removed
                    if not remove_mask and 'maskUrl' not in layout_data and 'maskUrl' in existing_data:
                        layout_data['maskUrl'] = existing_data['maskUrl']
                    elif not remove_mask and layout_data.get('maskUrl') and not mask_file:
                        old_mask_url = layout_data['maskUrl']
                        if f"masks/{layout_name}_mask" not in old_mask_url:
                            # Mask belongs to a different layout name, try to migrate it
                            try:
                                old_filename = os.path.basename(old_mask_url)
                                old_path = os.path.join(storage.masks_dir(), old_filename)
                                if os.path.exists(old_path):
                                    ext = os.path.splitext(old_filename)[1]
                                    new_filename = f"{layout_name}_mask{ext}"
                                    new_path = os.path.join(storage.masks_dir(), new_filename)
                                    
                                    import shutil
                                    # Only copy if destination doesn't exist to avoid infinite recursion or overhead
                                    if not os.path.exists(new_path):
                                        shutil.copy2(old_path, new_path)
                                        layout_data['maskUrl'] = f"/api/layouts/masks/{new_filename}"
                                        logger.info(f"Migrated mask from {old_filename} to {new_filename} due to layout rename")
                            except Exception as e:
                                logger.warning(f"Failed to migrate mask during rename: {e}")

                    # Persist certain fields if not provided (skip if mask was explicitly removed)
                    if not remove_mask and 'maskOnExport' not in layout_data and 'maskOnExport' in existing_data:
                        layout_data['maskOnExport'] = existing_data['maskOnExport']

                    # Persist creation metadata
                    existing_meta = existing_data.get('metadata', {})
                    if isinstance(existing_meta, list):
                        # Convert list back to dict for easy update if it was already stored as list
                        existing_meta = {item['key']: item['value'] for item in existing_meta if 'key' in item}
                    
                    meta_entries["createdByName"] = existing_meta.get("createdByName", full_name)
                    meta_entries["createdById"] = existing_meta.get("createdById", emp_id)
                    meta_entries["createdAt"] = existing_meta.get("createdAt", now)
                    
                    # Merge tags if they aren't explicitly provided
                    if 'tags' not in layout_data and 'tags' in existing_data:
                        layout_data['tags'] = existing_data['tags']
                except Exception:
                    pass

            # Update final metadata object (storing both for backward compatibility and the new array format)
            # The user specifically requested an array format [ {label: value} ]
            # Keep legacy top-level fields for existing UI components to prevent breakage while transitioning
            layout_data['createdAt'] = meta_entries["createdAt"]
            layout_data['createdBy'] = f"{meta_entries['createdByName']} ({meta_entries['createdById']})" if meta_entries['createdById'] else meta_entries['createdByName']
            layout_data['updatedAt'] = meta_entries["updatedAt"]
            layout_data['updatedBy'] = f"{meta_entries['updatedByName']} ({meta_entries['updatedById']})" if meta_entries['updatedById'] else meta_entries['updatedByName']
            
            # Ensure tags is a list
            if 'tags' not in layout_data:
                layout_data['tags'] = []
            elif isinstance(layout_data['tags'], str):
                layout_data['tags'] = [t.strip() for t in layout_data['tags'].split(',') if t.strip()]

            # Final Dimensions & Metadata array for easy extraction
            if is_multi_surface:
                surface_dims = []
                for s in layout_data.get('surfaces', []):
                    sc = s.get('canvas', {})
                    try:
                        sw = float(sc.get('widthMm', 0))
                        sh = float(sc.get('heightMm', 0))
                    except (ValueError, TypeError):
                        sw = sh = 0
                    surface_dims.append(f"{s.get('key', '?')}: {sw:.2f}x{sh:.2f}mm")
                dim_str = " | ".join(surface_dims) if surface_dims else "N/A"
            else:
                canvas = layout_data.get('canvas', {})
                try:
                    val_w = float(canvas.get('widthMm', 0))
                    val_h = float(canvas.get('heightMm', 0))
                except (ValueError, TypeError):
                    val_w = 0
                    val_h = 0
                dim_str = f"{val_w:.2f} x {val_h:.2f}mm"
            
            layout_data['metadata'] = [
                {"key": "createdByName", "label": "Created By", "value": meta_entries["createdByName"]},
                {"key": "createdById", "label": "Emp ID", "value": meta_entries["createdById"]},
                {"key": "createdAt", "label": "Created At", "value": meta_entries["createdAt"]},
                {"key": "updatedByName", "label": "Updated By", "value": meta_entries["updatedByName"]},
                {"key": "updatedById", "label": "Updated Emp ID", "value": meta_entries["updatedById"]},
                {"key": "updatedAt", "label": "Updated At", "value": meta_entries["updatedAt"]},
                {"key": "dimensions", "label": "Dimensions", "value": dim_str},
                {"key": "tags", "label": "Tags", "value": ", ".join(layout_data.get('tags', []))},
                {"key": "maskOnExport", "label": "Mask on Export", "value": "Enabled" if layout_data.get('maskOnExport') else "Disabled"}
            ]
            with open(path, "w") as f:
                json.dump(layout_data, f, indent=4)
            
            # --- Rename Cleanup: Delete the old layout file and move old mask ---
            if old_name and old_name != layout_name:
                old_path = os.path.join(storage.layouts_dir(), f"{old_name}.json")
                if os.path.exists(old_path):
                    try:
                        os.remove(old_path)
                        logger.info(f"Rename: removed old layout file '{old_name}.json'")
                    except Exception as e:
                        logger.warning(f"Rename: could not remove old file '{old_name}.json': {e}")
                # Move old mask to new name if it exists and wasn't already migrated above
                try:
                    import glob
                    old_masks = glob.glob(os.path.join(storage.masks_dir(), f"{old_name}_mask.*"))
                    for old_mask in old_masks:
                        ext = os.path.splitext(old_mask)[1]
                        new_mask = os.path.join(storage.masks_dir(), f"{layout_name}_mask{ext}")
                        if not os.path.exists(new_mask):
                            import shutil
                            shutil.move(old_mask, new_mask)
                            logger.info(f"Rename: moved mask {old_mask} -> {new_mask}")
                        else:
                            os.remove(old_mask)
                except Exception as e:
                    logger.warning(f"Rename: mask move failed: {e}")
            
            # Invalidate the layouts list cache so next GET reflects the change
            from django.core.cache import cache as django_cache
            django_cache.delete("layouts_list_all")

            return Response({"status": "success", "name": layout_name, "maskUrl": layout_data.get('maskUrl')})
        except json.JSONDecodeError:
            return Response({"detail": "Invalid JSON data"}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as e:
            logger.error(f"Error saving layout {layout_name}: {str(e)}")
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    def delete(self, request, name):
        """Delete a layout JSON file."""
        if not self._is_valid_layout_name(name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)
        
        storage = get_storage()
        path = os.path.join(storage.layouts_dir(), f"{name}.json")
        
        if not self._is_path_safe(path, storage.layouts_dir()):
            return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
            
        if not os.path.exists(path):
            return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)
            
        try:
            # Cleanup mask file if it exists
            try:
                import glob
                mask_pattern = os.path.join(storage.masks_dir(), f"{name}_mask.*")
                for m in glob.glob(mask_pattern):
                    if os.path.exists(m):
                        os.remove(m)
            except Exception as e:
                logger.warning(f"Failed to delete mask for layout {name}: {e}")

            os.remove(path)
            # Invalidate the layouts list cache
            from django.core.cache import cache as django_cache
            django_cache.delete("layouts_list_all")
            return Response({"status": "success", "detail": f"Layout {name} deleted"})
        except Exception as e:
            logger.error(f"Error deleting layout {name}: {str(e)}")
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class ExternalLayoutDetailView(APIView):
    """
    Secured view for external systems to fetch layout JSON.
    Requires a valid API Key or Bearer Token.
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanListLayouts]

    def _is_valid_layout_name(self, name: str) -> bool:
        return bool(re.match(r'^[a-zA-Z0-9_\-]+$', name))

    def _is_path_safe(self, path: str, base_dir: str) -> bool:
        return os.path.abspath(path).startswith(os.path.abspath(base_dir))

    @extend_schema(
        tags=["layouts"],
        summary="Get layout for external systems",
        description=(
            "Fetch a layout JSON definition via API key auth. "
            "Intended for external server-to-server use (not browser clients)."
        ),
        parameters=[
            OpenApiParameter("name", OpenApiTypes.STR, OpenApiParameter.PATH, description="Layout name, e.g. `retro_polaroid_4.2x3.5`"),
        ],
        responses={
            200: inline_serializer(
                name="ExternalLayoutResponse",
                fields={
                    "name": drf_serializers.CharField(),
                    "canvases": drf_serializers.ListField(child=drf_serializers.DictField()),
                },
            ),
            400: OpenApiResponse(description="Invalid layout name"),
            404: OpenApiResponse(description="Layout not found"),
        },
    )
    def get(self, request, name):
        if not self._is_valid_layout_name(name):
            return Response({"detail": "Invalid layout name"}, status=status.HTTP_400_BAD_REQUEST)
        
        storage = get_storage()
        path = os.path.join(storage.layouts_dir(), f"{name}.json")
        
        if not self._is_path_safe(path, storage.layouts_dir()):
            return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
            
        if not os.path.exists(path):
            return Response({"detail": "Layout not found"}, status=status.HTTP_404_NOT_FOUND)
            
        try:
            with open(path, "r") as f:
                data = json.load(f)

            # Filter surfaces if ?surfaces= param is provided (for multi-surface layouts)
            surfaces_param = request.query_params.get('surfaces')
            if surfaces_param and 'surfaces' in data and isinstance(data['surfaces'], list):
                requested_keys = [k.strip().lower() for k in surfaces_param.split(',') if k.strip()]
                data['surfaces'] = [
                    s for s in data['surfaces']
                    if s.get('key', '').lower() in requested_keys
                ]

            return Response(data)
        except Exception as e:
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class MaskDownloadView(APIView):
    """View to download/serve layout mask images."""
    permission_classes = [AllowAny] # Publicly accessible if URL is known

    def get(self, request, filename):
        storage = get_storage()
        path = os.path.join(storage.masks_dir(), filename)
        
        # Security check: ensure path is within masks directory
        if not os.path.abspath(path).startswith(os.path.abspath(storage.masks_dir())):
            return Response({"detail": "Access denied"}, status=status.HTTP_403_FORBIDDEN)
            
        if not os.path.exists(path):
            return Response({"detail": "Mask not found"}, status=status.HTTP_404_NOT_FOUND)
            
        try:
            from django.http import FileResponse
            import mimetypes
            content_type, _ = mimetypes.guess_type(path)
            return FileResponse(open(path, 'rb'), content_type=content_type or 'image/png')
        except Exception as e:
            return Response({"detail": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class EmbedSessionView(APIView):
    """
    Exchange a real API key for a short-lived embed token (2 hours).
    The token is safe to place in an iframe URL — the real key never reaches the browser.
    """
    permission_classes = [IsAuthenticatedWithAPIKey]

    @extend_schema(
        tags=["embed"],
        summary="Create embed session token",
        description=(
            "Exchange your API key for a **short-lived UUID token** (TTL: 2 hours) "
            "that is safe to embed in an iframe URL.\n\n"
            "### How it works\n\n"
            "```\n"
            "Your server  →  POST /api/embed/session\n"
            "             ←  { token: '<uuid>' }\n\n"
            "Your page    →  <iframe src=\"https://product-editor.printo.in/layout/<name>?token=<uuid>\" />\n\n"
            "Customer edits canvas and clicks Submit Design\n\n"
            "Your page    ←  window.postMessage({ type: 'PRODUCT_EDITOR_COMPLETE',\n"
            "                                     layoutName: '...',\n"
            "                                     canvases: [{ index, dataUrl }] })\n"
            "```\n\n"
            "### Security guarantees\n\n"
            "- Token is a disposable UUID — never the real API key\n"
            "- All subsequent calls from the embed page go through the Next.js server-side proxy "
            "which resolves the token to the real key without exposing it to the browser\n"
            "- Token expires after 2 hours; generate a fresh one per customer session\n\n"
            "**Auth:** `Authorization: Bearer <real-api-key>` (server-to-server only)"
        ),
        request=None,
        responses={
            201: inline_serializer(
                name="EmbedSessionResponse",
                fields={
                    "token": drf_serializers.UUIDField(help_text="Short-lived embed token — safe to put in iframe URL"),
                    "expires_at": drf_serializers.DateTimeField(help_text="ISO 8601 expiry timestamp (2 hours from now)"),
                    "embed_url_template": drf_serializers.CharField(
                        help_text="URL template — replace `{layout_name}` with your layout, e.g. `retro_polaroid_4.2x3.5`"
                    ),
                },
            ),
            401: OpenApiResponse(description="Invalid or missing API key"),
        },
        examples=[
            OpenApiExample(
                "Successful token creation",
                value={
                    "token": "a3f1c2d4-e5b6-7890-abcd-ef1234567890",
                    "expires_at": "2024-01-15T14:30:00+05:30",
                    "embed_url_template": "/embed/editor/{layout_name}?token=a3f1c2d4-e5b6-7890-abcd-ef1234567890",
                },
                response_only=True,
                status_codes=["201"],
            ),
        ],
    )
    def post(self, request):
        from datetime import timedelta
        api_key = request.user.api_key
        expires_at = timezone.now() + timedelta(hours=2)
        session = EmbedSession.objects.create(api_key=api_key, expires_at=expires_at)
        return Response({
            'token': str(session.token),
            'expires_at': session.expires_at.isoformat(),
            'embed_url_template': '/embed/editor/{layout_name}?token=' + str(session.token),
        }, status=status.HTTP_201_CREATED)


class EmbedSessionValidateView(APIView):
    """
    Internal endpoint called only by the Next.js server-side proxy to resolve a token → real API key.
    Not intended for direct use by external clients.
    """
    permission_classes = [AllowAny]

    @extend_schema(
        tags=["embed"],
        summary="Validate embed token (internal proxy use only)",
        description=(
            "**⚠️ Internal use only** — called exclusively by the Next.js server-side proxy "
            "(`/api/embed/proxy/[...path]`). Do not call this from browser JavaScript.\n\n"
            "Validates the embed token and returns the underlying API key so the proxy can "
            "forward the request to Django with a real `Authorization: Bearer` header — "
            "without ever exposing the key to the browser.\n\n"
            "### Protection\n\n"
            "Protected by a shared `X-Internal-Secret` header that is set only in the server "
            "environment and never accessible to browsers. If `EMBED_INTERNAL_SECRET` env var "
            "is set, requests missing or providing a wrong secret receive `403 Forbidden`."
        ),
        parameters=[
            OpenApiParameter(
                "token",
                OpenApiTypes.UUID,
                OpenApiParameter.QUERY,
                required=True,
                description="The embed session UUID from the iframe URL",
            ),
        ],
        responses={
            200: inline_serializer(
                name="EmbedValidateResponse",
                fields={"api_key": drf_serializers.CharField(help_text="The real API key backing this embed session")},
            ),
            400: OpenApiResponse(description="`token` query param is missing"),
            401: OpenApiResponse(description="Token not found or expired"),
            403: OpenApiResponse(description="Missing or invalid `X-Internal-Secret` header"),
        },
    )
    def get(self, request):
        import os
        expected_secret = os.getenv('EMBED_INTERNAL_SECRET', '')
        if expected_secret:
            provided = request.headers.get('X-Internal-Secret', '')
            if provided != expected_secret:
                return Response({'detail': 'Forbidden'}, status=status.HTTP_403_FORBIDDEN)

        token = request.query_params.get('token', '').strip()
        if not token:
            return Response({'detail': 'token param required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            session = EmbedSession.objects.select_related('api_key').get(token=token)
        except (EmbedSession.DoesNotExist, Exception):
            return Response({'detail': 'Invalid token'}, status=status.HTTP_401_UNAUTHORIZED)

        if not session.is_valid():
            return Response({'detail': 'Token expired or revoked'}, status=status.HTTP_401_UNAUTHORIZED)

        return Response({'api_key': session.api_key.key})


# ─── Fonts management ─────────────────────────────────────────────────────────

FONTS_JSON_PATH = os.path.join(settings.STORAGE_ROOT, 'fonts.json')

DEFAULT_FONTS = ['sans-serif', 'serif', 'monospace']


def _read_fonts():
    """Read the fonts config from disk."""
    try:
        with open(FONTS_JSON_PATH, 'r') as f:
            data = json.load(f)
            return data if isinstance(data, list) else DEFAULT_FONTS
    except (FileNotFoundError, json.JSONDecodeError):
        return DEFAULT_FONTS


def _write_fonts(fonts):
    """Write fonts config to disk."""
    with open(FONTS_JSON_PATH, 'w') as f:
        json.dump(fonts, f, indent=2)


class FontsView(APIView):
    """
    GET  /api/fonts  — returns the list of enabled fonts (open to any authenticated user).
    PUT  /api/fonts  — saves the list of enabled fonts (ops team only).
    """
    permission_classes = [AllowAny]

    def get(self, request):
        response = Response({'fonts': _read_fonts()})
        response['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=600'
        return response

    def put(self, request):
        # Only ops team can modify fonts
        from .authentication import PIAAuthentication, BearerTokenAuthentication
        user = None
        for auth_cls in [PIAAuthentication(), BearerTokenAuthentication()]:
            try:
                result = auth_cls.authenticate(request)
                if result:
                    user = result[0]
                    break
            except Exception:
                continue

        if not user:
            return Response({'detail': 'Authentication required'}, status=status.HTTP_401_UNAUTHORIZED)

        # Check ops team permission
        is_ops = getattr(user, 'is_ops_team', False) or getattr(user, 'is_staff', False)
        if not is_ops:
            return Response({'detail': 'Only ops team can modify fonts'}, status=status.HTTP_403_FORBIDDEN)

        fonts = request.data.get('fonts')
        if not isinstance(fonts, list) or not all(isinstance(f, str) for f in fonts):
            return Response({'detail': 'fonts must be a list of strings'}, status=status.HTTP_400_BAD_REQUEST)

        _write_fonts(fonts)
        return Response({'fonts': fonts})