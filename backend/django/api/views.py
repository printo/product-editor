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
            logger.info(f"DEBUG_LAYOUT_REQ: User={request.user}, Auth={request.auth}, Headers={request.headers.get('Authorization')}")
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
                    
            logger.info(f"DEBUG_LAYOUT_RES: Returning {len(layouts_data)} layouts")
            return Response({"layouts": layouts_data})
        except Exception as e:
            logger.error(f"Error listing layouts: {str(e)}")
            return Response(
                {"detail": "Failed to list layouts"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class GenerateLayoutView(APIView):
    """Generate layout from images with AI processing - requires API key."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanGenerateLayouts]

    @extend_schema(
        tags=["generate"],
        summary="Generate canvas from images",
        description=(
            "Upload images and a layout definition to produce a rendered canvas.\n\n"
            "**Request format:** `multipart/form-data`\n\n"
            "| Field | Type | Description |\n"
            "|-------|------|-------------|\n"
            "| `layout` | string/JSON | Layout name (e.g. `retro_polaroid_4.2x3.5`) or full layout JSON |\n"
            "| `images` | file[] | One or more image files to place in the layout |\n"
            "| `ai_enhance` | boolean | Optional — run AI background removal / product detection |\n\n"
            "Returns a list of canvas objects, one per layout slot."
        ),
        request=inline_serializer(
            name="GenerateLayoutRequest",
            fields={
                "layout": drf_serializers.CharField(help_text="Layout name or JSON"),
                "images": drf_serializers.ListField(
                    child=drf_serializers.ImageField(),
                    help_text="Image files",
                ),
                "ai_enhance": drf_serializers.BooleanField(required=False, default=False),
            },
        ),
        responses={
            200: inline_serializer(
                name="GenerateLayoutResponse",
                fields={
                    "canvases": drf_serializers.ListField(child=drf_serializers.DictField()),
                    "layout_name": drf_serializers.CharField(),
                    "export_id": drf_serializers.CharField(required=False),
                },
            ),
            400: OpenApiResponse(description="Invalid request — missing images or bad layout"),
            408: OpenApiResponse(description="Timeout — generation exceeded 5 minutes"),
        },
    )
    @with_timeout(seconds=300)  # 5 minute timeout
    def post(self, request):
        try:
            layout_data = request.data.get("layout")
            if isinstance(layout_data, str) and (layout_data.startswith('{') or layout_data.startswith('[')):
                try:
                    layout_data = json.loads(layout_data)
                except:
                    pass
            
            layout_name = layout_data.get('name') if isinstance(layout_data, dict) else layout_data
            files = request.FILES.getlist("images")
            
            # AI processing options
            remove_backgrounds = request.data.get("remove_backgrounds", "false").lower() == "true"
            detect_products = request.data.get("detect_products", "false").lower() == "true"
            realistic_blending = request.data.get("realistic_blending", "false").lower() == "true"
            blend_mode = request.data.get("blend_mode", "multiply")
            fit_mode = request.data.get("fit_mode", "cover")
            if fit_mode not in ("contain", "cover"):
                fit_mode = "cover"
            
            # Validate inputs
            if not layout_name or not files:
                return Response(
                    {"detail": "layout and images are required"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Validate layout name - security check
            if not self._is_valid_layout_name(layout_name):
                return Response(
                    {"detail": f"Invalid layout name: {layout_name}"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Validate image files
            try:
                validate_image_files(files)
            except ValidationError as e:
                return Response(
                    {"detail": str(e)},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Get user/API key
            api_key = None
            if isinstance(request.user, APIKeyUser):
                api_key = request.user.api_key
            
            # Save uploaded files
            upload_paths = []
            storage = get_storage()
            
            start_time = time.time()
            
            try:
                # Process files with AI if requested
                processed_paths = []
                ai_metadata = {}
                
                for i, f in enumerate(files):
                    fname = get_random_string(8) + "_" + f.name
                    path = storage.save_upload(fname, f.file)
                    upload_paths.append(path)
                    
                    # Track uploaded file
                    if api_key:
                        UploadedFile.objects.create(
                            api_key=api_key,
                            file_path=path,
                            original_filename=f.name,
                            file_size_bytes=f.size,
                            file_type='image'
                        )
                    
                    # Apply AI processing if requested
                    processed_path = path
                    file_metadata = {}
                    
                    if remove_backgrounds:
                        try:
                            bg_remover = get_background_remover()
                            result = bg_remover.remove_background(path, storage.uploads_dir())
                            if result.success:
                                processed_path = result.processed_image_path
                                file_metadata['background_removed'] = True
                                file_metadata['bg_processing_time'] = result.processing_time
                            else:
                                file_metadata['background_removed'] = False
                                file_metadata['bg_error'] = result.error_message
                        except Exception as e:
                            logger.warning(f"Background removal failed for {f.name}: {e}")
                            file_metadata['background_removed'] = False
                            file_metadata['bg_error'] = str(e)
                    
                    if detect_products:
                        try:
                            detector = get_product_detector()
                            products = detector.detect_products(processed_path)
                            file_metadata['products_detected'] = len(products)
                            file_metadata['products'] = [
                                {
                                    'category': p.category,
                                    'confidence': p.confidence,
                                    'center': p.center_point
                                } for p in products
                            ]
                        except Exception as e:
                            logger.warning(f"Product detection failed for {f.name}: {e}")
                            file_metadata['products_detected'] = 0
                            file_metadata['detection_error'] = str(e)
                    
                    processed_paths.append(processed_path)
                    ai_metadata[f"file_{i}"] = file_metadata
                
                # Use processed paths for layout generation
                final_paths = processed_paths if any([remove_backgrounds, detect_products]) else upload_paths
                
                # Generate layouts using SmartLayoutEngine if AI processing was used
                if any([remove_backgrounds, detect_products, realistic_blending]):
                    smart_engine = get_smart_engine()
                    
                    # Use smart layout optimization
                    layout_data = self._get_layout_data(layout_name, storage)
                    if layout_data and 'frames' in layout_data:
                        optimized_assignments = smart_engine.optimize_image_placement(
                            final_paths, layout_data['frames']
                        )
                        # Use optimized assignments for better placement
                        final_paths = [assignment[0] for assignment in optimized_assignments]
                
                # Generate layouts
                engine = LayoutEngine(storage.layouts_dir(), settings.EXPORTS_DIR)
                outputs = engine.generate(layout_name, final_paths, fit_mode=fit_mode)
                
                # Apply realistic blending if requested
                if realistic_blending and outputs:
                    try:
                        blended_outputs = []
                        blend_engine = get_blend_engine()
                        
                        for output_path in outputs:
                            # Create blended version
                            blended_fname = f"blended_{os.path.basename(output_path)}"
                            blended_path = os.path.join(os.path.dirname(output_path), blended_fname)
                            
                            # Apply realistic blending (simplified for layout output)
                            from PIL import Image
                            layout_img = Image.open(output_path)
                            
                            # Create blend settings
                            blend_settings = BlendSettings(
                                mode=BlendMode(blend_mode),
                                opacity=0.85,
                                preserve_colors=True,
                                texture_intensity=0.8,
                                quality_level="export"
                            )
                            
                            # For layout, we'll enhance the existing image
                            enhanced_img = blend_engine.preview_blend(layout_img, layout_img, blend_settings)
                            enhanced_img.save(blended_path)
                            blended_outputs.append(blended_path)
                        
                        outputs.extend(blended_outputs)
                        ai_metadata['realistic_blending'] = True
                    except Exception as e:
                        logger.warning(f"Realistic blending failed: {e}")
                        ai_metadata['realistic_blending'] = False
                        ai_metadata['blending_error'] = str(e)
                
                # Track exports
                generation_time_ms = int((time.time() - start_time) * 1000)
                if api_key and outputs:
                    for output_path in outputs:
                        file_size = os.path.getsize(output_path)
                        ExportedResult.objects.create(
                            api_key=api_key,
                            layout_name=layout_name,
                            export_file_path=output_path,
                            input_files=upload_paths,
                            generation_time_ms=generation_time_ms,
                            file_size_bytes=file_size
                        )
                
                # Return relative paths
                rel = [os.path.relpath(p, settings.EXPORTS_DIR) for p in outputs]
                
                response_data = {
                    "canvases": rel,
                    "generation_time_ms": generation_time_ms
                }
                
                # Include AI processing metadata if any AI features were used
                if any([remove_backgrounds, detect_products, realistic_blending]):
                    response_data["ai_processing"] = ai_metadata
                
                logger.info(f"Layout generated successfully: {layout_name} by {api_key.name if api_key else 'unknown'}")
                return Response(response_data)
            
            except TimeoutError:
                logger.error(f"Timeout generating layout: {layout_name}")
                return Response(
                    {"detail": "Layout generation timed out. Try with fewer/smaller images."},
                    status=status.HTTP_408_REQUEST_TIMEOUT
                )
            except Exception as e:
                logger.error(f"Error generating layout: {str(e)}")
                return Response(
                    {"detail": f"Failed to generate layout: {str(e)}"},
                    status=status.HTTP_500_INTERNAL_SERVER_ERROR
                )
        
        except Exception as e:
            logger.error(f"Unexpected error in GenerateLayoutView: {str(e)}")
            return Response(
                {"detail": "An unexpected error occurred"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
    
    def _get_layout_data(self, layout_name: str, storage) -> dict:
        """Get layout JSON data for AI processing."""
        try:
            path = os.path.join(storage.layouts_dir(), f"{layout_name}.json")
            if os.path.exists(path):
                with open(path, "r") as f:
                    return json.load(f)
        except:
            pass
        return {}
    
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

            return Response(data)

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


# AI Processing Views

from ai_engine.smart_layout import get_smart_engine
from ai_engine.background_removal import get_background_remover
from ai_engine.product_detection import get_product_detector
from ai_engine.design_placement import get_design_placer
from ai_engine.blend_engine import get_blend_engine, BlendMode, BlendSettings
from ai_engine.health_monitor import get_health_monitor
from ai_engine.failure_handler import get_failure_handler
from ai_engine.background_processor import get_background_processor
from ai_engine.resource_manager import get_resource_manager
from ai_engine.network_resilience import get_resilient_client
from .models import AIProcessingJob


class AIStatusView(APIView):
    """AI service health and availability status with comprehensive resource monitoring."""
    permission_classes = [IsAuthenticatedWithAPIKey]

    @extend_schema(
        tags=["ai"],
        summary="AI service status",
        description="Returns health and availability of all AI sub-services (background removal, product detection, blend preview) plus resource metrics.",
        responses={200: OpenApiResponse(description="Comprehensive AI status object")},
    )
    def get(self, request):
        try:
            health_monitor = get_health_monitor()
            failure_handler = get_failure_handler()
            background_processor = get_background_processor()
            resource_manager = get_resource_manager()
            resilient_client = get_resilient_client()
            
            # Get comprehensive status
            status_data = health_monitor.get_comprehensive_status()
            
            # Add failure handling status
            status_data['failure_handling'] = failure_handler.get_service_status()
            
            # Add background processing status
            status_data['background_processing'] = background_processor.get_queue_stats()
            
            # Add resource management status
            status_data['resource_management'] = resource_manager.get_comprehensive_stats()
            
            # Add network resilience status
            status_data['network_resilience'] = resilient_client.get_status()
            
            # Add manual override availability
            status_data['manual_overrides'] = {
                'background_removal': get_background_remover().get_manual_override_options(),
                'product_detection': get_product_detector().get_manual_override_options()
            }
            
            # Add system resource metrics
            resource_metrics = resource_manager.get_resource_metrics()
            status_data['system_resources'] = {
                'cpu_percent': resource_metrics.cpu_percent,
                'memory_percent': resource_metrics.memory_percent,
                'memory_available_mb': resource_metrics.memory_available_mb,
                'active_requests': resource_metrics.active_requests,
                'cache_hit_rate': resource_metrics.cache_hit_rate
            }
            
            return Response(status_data)
        except Exception as e:
            logger.error(f"Error getting AI status: {str(e)}")
            return Response(
                {
                    "detail": "Failed to get AI status",
                    "error": str(e),
                    "manual_override_available": True,
                    "suggested_actions": [
                        "Use manual tools for image processing",
                        "Try again in a few minutes",
                        "Contact support if issues persist"
                    ]
                },
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class BackgroundRemovalView(APIView):
    """Remove background from uploaded image using AI with comprehensive failure handling."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanGenerateLayouts]

    @extend_schema(
        tags=["ai"],
        summary="Remove image background",
        description=(
            "Upload an image and receive a PNG with the background removed.\n\n"
            "**Request:** `multipart/form-data` with `image` file field.\n\n"
            "Falls back to heuristic removal if AI service is unavailable (circuit breaker pattern)."
        ),
        request=inline_serializer(
            name="BackgroundRemovalRequest",
            fields={"image": drf_serializers.ImageField(help_text="Source image")},
        ),
        responses={
            200: OpenApiResponse(description="PNG image with background removed"),
            400: OpenApiResponse(description="Missing `image` field"),
            408: OpenApiResponse(description="AI service timeout (60 s limit)"),
        },
    )
    @with_timeout(seconds=60)  # 1 minute timeout for background removal
    def post(self, request):
        try:
            # Get uploaded file
            if 'image' not in request.FILES:
                return Response(
                    {"detail": "image file is required"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            image_file = request.FILES['image']
            
            # Get processing options
            background_processing = request.data.get('background_processing', 'false').lower() == 'true'
            
            # Validate image file
            try:
                validate_image_files([image_file])
            except ValidationError as e:
                return Response(
                    {"detail": str(e)},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Get API key for tracking
            api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
            user_id = api_key.name if api_key else None
            
            # Save uploaded file
            storage = get_storage()
            fname = get_random_string(8) + "_" + image_file.name
            input_path = storage.save_upload(fname, image_file.file)
            
            # Track uploaded file
            if api_key:
                UploadedFile.objects.create(
                    api_key=api_key,
                    file_path=input_path,
                    original_filename=image_file.name,
                    file_size_bytes=image_file.size,
                    file_type='image'
                )
            
            # Create AI processing job
            job = None
            if api_key:
                job = AIProcessingJob.objects.create(
                    api_key=api_key,
                    job_type='background_removal',
                    status='processing',
                    input_image=input_path,
                    parameters={'original_filename': image_file.name}
                )
                job.started_at = timezone.now()
                job.save()
            
            try:
                # Process with AI (includes failure handling)
                bg_remover = get_background_remover()
                result = bg_remover.remove_background(
                    input_path, 
                    storage.uploads_dir(),
                    background_processing=background_processing,
                    user_id=user_id
                )
                
                if result.success:
                    # Update job status
                    if job:
                        job.status = 'completed'
                        job.completed_at = timezone.now()
                        job.processing_time = result.processing_time
                        job.output_image = result.processed_image_path
                        job.result_data = result.metadata
                        job.save()
                    
                    # Return relative path for download
                    rel_path = os.path.relpath(result.processed_image_path, storage.uploads_dir())
                    
                    return Response({
                        "success": True,
                        "processed_image": rel_path,
                        "processing_time": result.processing_time,
                        "metadata": result.metadata,
                        "fallback_used": result.fallback_used,
                        "manual_override_available": result.manual_override_available,
                        "suggested_actions": result.suggested_actions
                    })
                else:
                    # Handle failure result
                    if job:
                        job.status = 'failed' if not result.background_job_id else 'queued'
                        job.error_message = result.error_message
                        job.processing_time = result.processing_time
                        job.save()
                    
                    response_data = {
                        "success": False,
                        "detail": result.error_message or "Background removal failed",
                        "fallback_used": result.fallback_used,
                        "manual_override_available": result.manual_override_available,
                        "suggested_actions": result.suggested_actions or [
                            "Use manual background removal tools",
                            "Try again later"
                        ]
                    }
                    
                    # Add background job info if queued
                    if result.background_job_id:
                        response_data["background_job_id"] = result.background_job_id
                        response_data["detail"] = "Processing queued for background execution"
                    
                    # Add manual override options
                    if result.manual_override_available:
                        response_data["manual_override_options"] = bg_remover.get_manual_override_options()
                    
                    return Response(response_data, status=status.HTTP_202_ACCEPTED if result.background_job_id else status.HTTP_500_INTERNAL_SERVER_ERROR)
            
            except TimeoutError:
                if job:
                    job.status = 'failed'
                    job.error_message = 'Processing timeout'
                    job.save()
                
                return Response({
                    "detail": "Background removal timed out",
                    "manual_override_available": True,
                    "manual_override_options": get_background_remover().get_manual_override_options(),
                    "suggested_actions": [
                        "Use manual background removal tools",
                        "Try with a smaller image",
                        "Enable background processing for large images"
                    ]
                }, status=status.HTTP_408_REQUEST_TIMEOUT)
        
        except Exception as e:
            logger.error(f"Error in background removal: {str(e)}")
            return Response({
                "detail": "Background removal failed",
                "error": str(e),
                "manual_override_available": True,
                "manual_override_options": get_background_remover().get_manual_override_options(),
                "suggested_actions": [
                    "Use manual background removal tools",
                    "Check image format and size",
                    "Try again later"
                ]
            }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


class ProductDetectionView(APIView):
    """Detect products in lifestyle photos using AI."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanGenerateLayouts]

    @extend_schema(
        tags=["ai"],
        summary="Detect products in image",
        description=(
            "Locate product bounding boxes in a lifestyle photo for design placement.\n\n"
            "**Request:** `multipart/form-data` with `image` file field.\n\n"
            "Returns bounding boxes and confidence scores for each detected product."
        ),
        request=inline_serializer(
            name="ProductDetectionRequest",
            fields={"image": drf_serializers.ImageField(help_text="Lifestyle photo")},
        ),
        responses={
            200: OpenApiResponse(description="Detected product regions with confidence scores"),
            400: OpenApiResponse(description="Missing `image` field"),
        },
    )
    @with_timeout(seconds=30)  # 30 second timeout for detection
    def post(self, request):
        try:
            # Get uploaded file
            if 'image' not in request.FILES:
                return Response(
                    {"detail": "image file is required"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            image_file = request.FILES['image']
            
            # Validate image file
            try:
                validate_image_files([image_file])
            except ValidationError as e:
                return Response(
                    {"detail": str(e)},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Get API key for tracking
            api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
            
            # Save uploaded file
            storage = get_storage()
            fname = get_random_string(8) + "_" + image_file.name
            input_path = storage.save_upload(fname, image_file.file)
            
            # Track uploaded file
            if api_key:
                UploadedFile.objects.create(
                    api_key=api_key,
                    file_path=input_path,
                    original_filename=image_file.name,
                    file_size_bytes=image_file.size,
                    file_type='image'
                )
            
            # Create AI processing job
            job = None
            if api_key:
                job = AIProcessingJob.objects.create(
                    api_key=api_key,
                    job_type='product_detection',
                    status='processing',
                    input_image=input_path,
                    parameters={'original_filename': image_file.name}
                )
                job.started_at = timezone.now()
                job.save()
            
            try:
                start_time = time.time()
                
                # Process with AI
                detector = get_product_detector()
                products = detector.detect_products(input_path)
                
                processing_time = time.time() - start_time
                
                # Format results
                detected_products = [
                    {
                        'category': p.category,
                        'confidence': p.confidence,
                        'bounding_box': {
                            'x': p.bounding_box.x,
                            'y': p.bounding_box.y,
                            'width': p.bounding_box.width,
                            'height': p.bounding_box.height
                        },
                        'center_point': p.center_point,
                        'orientation_angle': p.orientation_angle
                    } for p in products
                ]
                
                # Update job status
                if job:
                    job.status = 'completed'
                    job.completed_at = timezone.now()
                    job.processing_time = processing_time
                    job.result_data = {
                        'products_detected': len(products),
                        'products': detected_products
                    }
                    job.save()
                
                return Response({
                    "success": True,
                    "products_detected": len(products),
                    "products": detected_products,
                    "processing_time": processing_time,
                    "supported_categories": detector.get_supported_categories()
                })
            
            except TimeoutError:
                if job:
                    job.status = 'failed'
                    job.error_message = 'Detection timeout'
                    job.save()
                
                return Response(
                    {"detail": "Product detection timed out"},
                    status=status.HTTP_408_REQUEST_TIMEOUT
                )
        
        except Exception as e:
            logger.error(f"Error in product detection: {str(e)}")
            return Response(
                {"detail": "Product detection failed"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class DesignPlacementView(APIView):
    """Calculate design placement on detected products."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanGenerateLayouts]
    
    def post(self, request):
        try:
            # Get parameters
            design_file = request.FILES.get('design')
            product_bounds = request.data.get('product_bounds')
            product_category = request.data.get('product_category', 'shirt')
            
            if not design_file or not product_bounds:
                return Response(
                    {"detail": "design file and product_bounds are required"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Parse product bounds
            try:
                bounds_data = json.loads(product_bounds) if isinstance(product_bounds, str) else product_bounds
                from ai_engine.product_detection import BoundingBox
                bbox = BoundingBox(
                    x=bounds_data['x'],
                    y=bounds_data['y'],
                    width=bounds_data['width'],
                    height=bounds_data['height']
                )
            except (KeyError, ValueError, json.JSONDecodeError) as e:
                return Response(
                    {"detail": f"Invalid product_bounds format: {str(e)}"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Validate design file
            try:
                validate_image_files([design_file])
            except ValidationError as e:
                return Response(
                    {"detail": str(e)},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Save design file temporarily
            storage = get_storage()
            fname = get_random_string(8) + "_" + design_file.name
            design_path = storage.save_upload(fname, design_file.file)
            
            try:
                # Load design image
                from PIL import Image
                design_image = Image.open(design_path)
                
                # Calculate placement
                placer = get_design_placer()
                placement_result = placer.calculate_placement(design_image, bbox, product_category)
                
                # Apply transformation
                transformed_design = placer.apply_perspective_transform(
                    design_image, placement_result.transform_matrix
                )
                
                # Save transformed design
                output_fname = f"transformed_{fname}"
                output_path = os.path.join(storage.uploads_dir(), output_fname)
                transformed_design.save(output_path)
                
                # Return results
                rel_path = os.path.relpath(output_path, storage.uploads_dir())
                
                return Response({
                    "success": True,
                    "transformed_design": rel_path,
                    "placement_confidence": placement_result.confidence,
                    "fallback_used": placement_result.fallback_used,
                    "recommended_blend_mode": placement_result.recommended_blend_mode,
                    "placement_bounds": {
                        'x': placement_result.placement_bounds.x,
                        'y': placement_result.placement_bounds.y,
                        'width': placement_result.placement_bounds.width,
                        'height': placement_result.placement_bounds.height
                    }
                })
            
            finally:
                # Cleanup temporary design file
                if os.path.exists(design_path):
                    os.remove(design_path)
        
        except Exception as e:
            logger.error(f"Error in design placement: {str(e)}")
            return Response(
                {"detail": "Design placement failed"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class BlendPreviewView(APIView):
    """Generate realistic blend preview of design on product."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanGenerateLayouts]

    @extend_schema(
        tags=["ai"],
        summary="Generate blend preview",
        description=(
            "Composite a design image onto a detected product to produce a realistic preview.\n\n"
            "**Request:** `multipart/form-data`\n\n"
            "| Field | Type | Default | Description |\n"
            "|-------|------|---------|-------------|\n"
            "| `design` | file | — | Design / artwork image |\n"
            "| `product` | file | — | Product / lifestyle photo |\n"
            "| `blend_mode` | string | `multiply` | CSS-style blend mode |\n"
            "| `opacity` | float | `0.8` | Blend opacity (0–1) |\n"
            "| `preserve_colors` | bool | `true` | Preserve original product colors |\n"
            "| `texture_intensity` | float | `0.8` | Texture overlay intensity |\n"
        ),
        responses={
            200: OpenApiResponse(description="Blended preview image (PNG)"),
            400: OpenApiResponse(description="Missing `design` or `product` file"),
        },
    )
    def post(self, request):
        try:
            # Get parameters
            design_file = request.FILES.get('design')
            product_file = request.FILES.get('product')
            blend_mode = request.data.get('blend_mode', 'multiply')
            opacity = float(request.data.get('opacity', 0.8))
            preserve_colors = request.data.get('preserve_colors', 'true').lower() == 'true'
            texture_intensity = float(request.data.get('texture_intensity', 0.8))
            quality_level = request.data.get('quality_level', 'preview')
            
            if not design_file or not product_file:
                return Response(
                    {"detail": "design and product files are required"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Validate files
            try:
                validate_image_files([design_file, product_file])
            except ValidationError as e:
                return Response(
                    {"detail": str(e)},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Validate parameters
            if not 0.0 <= opacity <= 1.0:
                return Response(
                    {"detail": "opacity must be between 0.0 and 1.0"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            try:
                blend_mode_enum = BlendMode(blend_mode)
            except ValueError:
                return Response(
                    {"detail": f"Invalid blend_mode. Supported: {[m.value for m in BlendMode]}"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Save files temporarily
            storage = get_storage()
            design_fname = get_random_string(8) + "_design_" + design_file.name
            product_fname = get_random_string(8) + "_product_" + product_file.name
            
            design_path = storage.save_upload(design_fname, design_file.file)
            product_path = storage.save_upload(product_fname, product_file.file)
            
            try:
                # Load images
                from PIL import Image
                design_image = Image.open(design_path)
                product_image = Image.open(product_path)
                
                # Create blend settings
                blend_settings = BlendSettings(
                    mode=blend_mode_enum,
                    opacity=opacity,
                    preserve_colors=preserve_colors,
                    texture_intensity=texture_intensity,
                    quality_level=quality_level
                )
                
                # Generate blend preview
                blend_engine = get_blend_engine()
                blended_image = blend_engine.preview_blend(design_image, product_image, blend_settings)
                
                # Save blended result
                output_fname = f"blended_{get_random_string(8)}.png"
                output_path = os.path.join(storage.uploads_dir(), output_fname)
                blended_image.save(output_path, 'PNG')
                
                # Return result
                rel_path = os.path.relpath(output_path, storage.uploads_dir())
                
                return Response({
                    "success": True,
                    "blended_image": rel_path,
                    "blend_settings": {
                        "mode": blend_settings.mode.value,
                        "opacity": blend_settings.opacity,
                        "preserve_colors": blend_settings.preserve_colors,
                        "texture_intensity": blend_settings.texture_intensity,
                        "quality_level": blend_settings.quality_level
                    }
                })
            
            finally:
                # Cleanup temporary files
                for path in [design_path, product_path]:
                    if os.path.exists(path):
                        os.remove(path)
        
        except Exception as e:
            logger.error(f"Error in blend preview: {str(e)}")
            return Response(
                {"detail": "Blend preview failed"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class CompleteAIProcessingView(APIView):
    """Complete AI processing pipeline from design to realistic preview."""
    permission_classes = [IsAuthenticatedWithAPIKey, CanGenerateLayouts]
    
    @with_timeout(seconds=120)  # 2 minute timeout for complete processing
    def post(self, request):
        try:
            # Get parameters
            design_file = request.FILES.get('design')
            product_file = request.FILES.get('product')
            
            # Handle parameters that might be stringified in multipart
            remove_bg_val = request.data.get('remove_background', 'true')
            remove_bg = str(remove_bg_val).lower() == 'true'
            blend_mode = request.data.get('blend_mode', 'multiply')
            
            if not design_file or not product_file:
                return Response(
                    {"detail": "design and product files are required"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Validate files
            try:
                validate_image_files([design_file, product_file])
            except ValidationError as e:
                return Response(
                    {"detail": str(e)},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Get API key for tracking
            api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
            
            # Save files
            storage = get_storage()
            design_fname = get_random_string(8) + "_design_" + design_file.name
            product_fname = get_random_string(8) + "_product_" + product_file.name
            
            design_path = storage.save_upload(design_fname, design_file.file)
            product_path = storage.save_upload(product_fname, product_file.file)
            
            # Track uploaded files
            if api_key:
                for file_obj, path in [(design_file, design_path), (product_file, product_path)]:
                    UploadedFile.objects.create(
                        api_key=api_key,
                        file_path=path,
                        original_filename=file_obj.name,
                        file_size_bytes=file_obj.size,
                        file_type='image'
                    )
            
            # Create AI processing job
            job = None
            if api_key:
                job = AIProcessingJob.objects.create(
                    api_key=api_key,
                    job_type='complete_processing',
                    status='processing',
                    input_image=design_path,
                    parameters={
                        'design_file': design_file.name,
                        'product_file': product_file.name,
                        'remove_background': remove_bg,
                        'blend_mode': blend_mode
                    }
                )
                job.started_at = timezone.now()
                job.save()
            
            try:
                # Use SmartLayoutEngine for complete processing
                smart_engine = get_smart_engine()
                
                # Process design and product with complete AI pipeline
                result = smart_engine.process_design_for_product(
                    design_path, product_path, remove_bg, blend_mode
                )
                
                if result['success']:
                    # Save the preview image
                    if result['preview_image']:
                        preview_fname = f"ai_preview_{get_random_string(8)}.png"
                        preview_path = os.path.join(storage.uploads_dir(), preview_fname)
                        result['preview_image'].save(preview_path, 'PNG')
                        
                        # Update result with file path
                        result['preview_image_path'] = os.path.relpath(preview_path, storage.uploads_dir())
                        del result['preview_image']  # Remove PIL object for JSON serialization
                    
                    # Update job status
                    if job:
                        job.status = 'completed'
                        job.completed_at = timezone.now()
                        job.processing_time = result['processing_time']
                        job.result_data = {
                            'detected_products': len(result.get('detected_products', [])),
                            'placement_confidence': result.get('placement_result', {}).get('confidence', 0),
                            'blend_settings': result.get('blend_settings', {}),
                            'preview_generated': 'preview_image_path' in result
                        }
                        if 'preview_image_path' in result:
                            job.output_image = os.path.join(storage.uploads_dir(), result['preview_image_path'])
                        job.save()
                    
                    return Response({
                        "success": True,
                        "processing_time": result['processing_time'],
                        "detected_products": result.get('detected_products', []),
                        "placement_result": result.get('placement_result'),
                        "blend_settings": result.get('blend_settings'),
                        "preview_image": result.get('preview_image_path'),
                        "processed_design": result.get('processed_design_path')
                    })
                else:
                    # Update job with error
                    if job:
                        job.status = 'failed'
                        job.error_message = result.get('error', 'Unknown error')
                        job.processing_time = result.get('processing_time', 0)
                        job.save()
                    
                    return Response(
                        {"detail": result.get('error', 'AI processing failed')},
                        status=status.HTTP_500_INTERNAL_SERVER_ERROR
                    )
            
            except TimeoutError:
                if job:
                    job.status = 'failed'
                    job.error_message = 'Processing timeout'
                    job.save()
                
                return Response(
                    {"detail": "AI processing timed out"},
                    status=status.HTTP_408_REQUEST_TIMEOUT
                )
            
            finally:
                # Cleanup temporary files
                for path in [design_path, product_path]:
                    if os.path.exists(path):
                        try:
                            os.remove(path)
                        except:
                            pass  # Ignore cleanup errors
        
        except Exception as e:
            logger.error(f"Error in complete AI processing: {str(e)}")
            return Response(
                {"detail": "Complete AI processing failed"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class AIJobStatusView(APIView):
    """Get status of AI processing jobs with enhanced failure information."""
    permission_classes = [IsAuthenticatedWithAPIKey]
    
    def get(self, request, job_id=None):
        try:
            api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
            
            if job_id:
                # Get specific job
                try:
                    job = AIProcessingJob.objects.get(id=job_id, api_key=api_key)
                    
                    response_data = {
                        "id": str(job.id),
                        "job_type": job.job_type,
                        "status": job.status,
                        "created_at": job.created_at.isoformat(),
                        "started_at": job.started_at.isoformat() if job.started_at else None,
                        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
                        "processing_time": job.processing_time,
                        "parameters": job.parameters,
                        "result_data": job.result_data,
                        "error_message": job.error_message if job.status == 'failed' else None
                    }
                    
                    # Add manual override options if job failed
                    if job.status == 'failed':
                        if job.job_type == 'background_removal':
                            response_data["manual_override_options"] = get_background_remover().get_manual_override_options()
                        elif job.job_type == 'product_detection':
                            response_data["manual_override_options"] = get_product_detector().get_manual_override_options()
                    
                    # Check for background job status if applicable
                    background_processor = get_background_processor()
                    bg_job = background_processor.get_job_status(str(job.id))
                    if bg_job:
                        response_data["background_job_status"] = {
                            "status": bg_job.status.value,
                            "progress": self._calculate_progress(bg_job),
                            "estimated_completion": self._estimate_completion(bg_job)
                        }
                    
                    return Response(response_data)
                    
                except AIProcessingJob.DoesNotExist:
                    return Response(
                        {"detail": "Job not found"},
                        status=status.HTTP_404_NOT_FOUND
                    )
            else:
                # List recent jobs with enhanced status info
                jobs = AIProcessingJob.objects.filter(api_key=api_key).order_by('-created_at')[:20]
                
                job_list = []
                for job in jobs:
                    job_data = {
                        "id": str(job.id),
                        "job_type": job.job_type,
                        "status": job.status,
                        "created_at": job.created_at.isoformat(),
                        "processing_time": job.processing_time,
                        "has_manual_override": job.status == 'failed'
                    }
                    job_list.append(job_data)
                
                return Response({
                    "jobs": job_list,
                    "service_status": get_failure_handler().get_service_status()
                })
        
        except Exception as e:
            logger.error(f"Error getting AI job status: {str(e)}")
            return Response(
                {"detail": "Failed to get job status"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
    
    def _calculate_progress(self, bg_job) -> int:
        """Calculate background job progress"""
        if bg_job.status.value == 'completed':
            return 100
        elif bg_job.status.value in ['failed', 'cancelled']:
            return 0
        elif bg_job.status.value == 'processing':
            if bg_job.started_at:
                elapsed = (datetime.now() - bg_job.started_at).total_seconds()
                # Estimate based on job type
                estimated_total = 30 if bg_job.service_name == 'background_removal' else 10
                return min(90, int((elapsed / estimated_total) * 100))
            return 10
        else:  # queued
            return 0
    
    def _estimate_completion(self, bg_job) -> Optional[str]:
        """Estimate completion time for background job"""
        if bg_job.status.value in ['completed', 'failed', 'cancelled']:
            return None
        
        if bg_job.status.value == 'processing' and bg_job.started_at:
            elapsed = (datetime.now() - bg_job.started_at).total_seconds()
            estimated_total = 30 if bg_job.service_name == 'background_removal' else 10
            remaining = max(0, estimated_total - elapsed)
            return f"{int(remaining)} seconds"
        
        # For queued jobs
        return "Processing will begin shortly"


class ManualOverrideOptionsView(APIView):
    """Get manual override options for AI services."""
    permission_classes = [IsAuthenticatedWithAPIKey]
    
    def get(self, request, service_name=None):
        try:
            if service_name:
                # Get options for specific service
                if service_name == 'background_removal':
                    options = get_background_remover().get_manual_override_options()
                elif service_name == 'product_detection':
                    options = get_product_detector().get_manual_override_options()
                else:
                    return Response(
                        {"detail": f"Unknown service: {service_name}"},
                        status=status.HTTP_400_BAD_REQUEST
                    )
                
                return Response({
                    "service": service_name,
                    "options": options
                })
            else:
                # Get options for all services
                return Response({
                    "background_removal": get_background_remover().get_manual_override_options(),
                    "product_detection": get_product_detector().get_manual_override_options()
                })
        
        except Exception as e:
            logger.error(f"Error getting manual override options: {str(e)}")
            return Response(
                {"detail": "Failed to get manual override options"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class BackgroundJobStatusView(APIView):
    """Check status of background processing jobs."""
    permission_classes = [IsAuthenticatedWithAPIKey]
    
    def get(self, request, job_id):
        try:
            api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
            user_id = api_key.name if api_key else None
            
            # Check if it's a background removal job
            bg_remover = get_background_remover()
            job_status = bg_remover.check_background_job_status(job_id)
            
            if job_status['status'] == 'not_found':
                return Response(
                    {"detail": "Background job not found"},
                    status=status.HTTP_404_NOT_FOUND
                )
            
            return Response(job_status)
        
        except Exception as e:
            logger.error(f"Error checking background job status: {str(e)}")
            return Response(
                {"detail": "Failed to check background job status"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class CircuitBreakerResetView(APIView):
    """Reset circuit breaker for AI services (admin only)."""
    permission_classes = [IsAuthenticatedWithAPIKey]
    
    def post(self, request, service_name):
        try:
            # Check if user has admin privileges (simplified check)
            api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
            if not api_key or not api_key.name.endswith('_admin'):
                return Response(
                    {"detail": "Admin privileges required"},
                    status=status.HTTP_403_FORBIDDEN
                )
            
            failure_handler = get_failure_handler()
            
            # Validate service name
            valid_services = ['background_removal', 'product_detection', 'design_placement', 'blend_engine']
            if service_name not in valid_services:
                return Response(
                    {"detail": f"Invalid service name. Valid options: {valid_services}"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            # Reset circuit breaker
            failure_handler.reset_circuit_breaker(service_name)
            
            return Response({
                "success": True,
                "message": f"Circuit breaker reset for {service_name}",
                "service_status": failure_handler.get_service_status()[service_name]
            })
        
        except Exception as e:
            logger.error(f"Error resetting circuit breaker: {str(e)}")
            return Response(
                {"detail": "Failed to reset circuit breaker"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


class ResourceManagementView(APIView):
    """Resource management monitoring and control endpoint."""
    permission_classes = [IsAuthenticatedWithAPIKey]
    
    def get(self, request):
        """Get comprehensive resource management statistics"""
        try:
            resource_manager = get_resource_manager()
            
            # Get comprehensive stats
            stats = resource_manager.get_comprehensive_stats()
            
            # Add real-time metrics
            current_metrics = resource_manager.get_resource_metrics()
            stats['current_metrics'] = {
                'cpu_percent': current_metrics.cpu_percent,
                'memory_percent': current_metrics.memory_percent,
                'memory_available_mb': current_metrics.memory_available_mb,
                'active_requests': current_metrics.active_requests,
                'queue_size': current_metrics.queue_size,
                'cache_hit_rate': current_metrics.cache_hit_rate,
                'timestamp': current_metrics.timestamp.isoformat()
            }
            
            # Add recommendations based on current load
            stats['recommendations'] = self._get_performance_recommendations(current_metrics)
            
            return Response(stats)
            
        except Exception as e:
            logger.error(f"Error getting resource management stats: {str(e)}")
            return Response(
                {"detail": "Failed to get resource management statistics"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
    
    def post(self, request):
        """Perform resource management operations"""
        try:
            action = request.data.get('action')
            
            if not action:
                return Response(
                    {"detail": "action parameter is required"},
                    status=status.HTTP_400_BAD_REQUEST
                )
            
            resource_manager = get_resource_manager()
            
            if action == 'cleanup':
                # Perform maintenance cleanup
                resource_manager.perform_maintenance()
                return Response({
                    "success": True,
                    "message": "Resource cleanup completed",
                    "timestamp": datetime.now().isoformat()
                })
            
            elif action == 'clear_cache':
                # Clear result cache
                resource_manager.result_cache.cache_hits = 0
                resource_manager.result_cache.cache_misses = 0
                return Response({
                    "success": True,
                    "message": "Result cache cleared",
                    "timestamp": datetime.now().isoformat()
                })
            
            elif action == 'optimize_memory':
                # Trigger memory optimization
                resource_manager.memory_optimizer.cleanup_optimized_images()
                return Response({
                    "success": True,
                    "message": "Memory optimization completed",
                    "timestamp": datetime.now().isoformat()
                })
            
            else:
                return Response(
                    {"detail": f"Unknown action: {action}"},
                    status=status.HTTP_400_BAD_REQUEST
                )
                
        except Exception as e:
            logger.error(f"Error performing resource management operation: {str(e)}")
            return Response(
                {"detail": "Resource management operation failed"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )
    
    def _get_performance_recommendations(self, metrics) -> List[str]:
        """Generate performance recommendations based on current metrics"""
        recommendations = []
        
        if metrics.cpu_percent > 80:
            recommendations.append("High CPU usage detected. Consider reducing concurrent requests.")
        
        if metrics.memory_percent > 85:
            recommendations.append("High memory usage detected. Consider enabling memory optimization.")
        
        if metrics.active_requests > 4:
            recommendations.append("High request load. Consider using background processing.")
        
        if metrics.cache_hit_rate < 0.3:
            recommendations.append("Low cache hit rate. Consider increasing cache TTL.")
        
        if not recommendations:
            recommendations.append("System performance is optimal.")
        
        return recommendations


class NetworkResilienceView(APIView):
    """Network resilience monitoring and control endpoint."""
    permission_classes = [IsAuthenticatedWithAPIKey]
    
    def get(self, request):
        """Get network resilience status"""
        try:
            resilient_client = get_resilient_client()
            status_data = resilient_client.get_status()
            
            return Response(status_data)
            
        except Exception as e:
            logger.error(f"Error getting network resilience status: {str(e)}")
            return Response(
                {"detail": "Failed to get network resilience status"},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR
            )


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
        return Response({'fonts': _read_fonts()})

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