"""Delivering finished renders: the per-job ZIP download (combined or split by ?content=) and secure export downloads."""
import os
import re
import logging
from django.conf import settings
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from drf_spectacular.utils import extend_schema, OpenApiParameter, OpenApiResponse
from drf_spectacular.types import OpenApiTypes
from ..permissions import IsAuthenticatedWithAPIKey, CanAccessExports
from ..authentication import APIKeyUser
from ..models import UploadedFile

logger = logging.getLogger(__name__)


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
            
            # Construct full path — export files live under EXPORTS_DIR.
            # MEDIA_ROOT does not exist in this project's settings; using it
            # caused every download to resolve against a nonexistent directory.
            base_dir = settings.EXPORTS_DIR
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
            
            import mimetypes
            content_type, _ = mimetypes.guess_type(full_path)
            response = Response(file_content)
            response['Content-Type'] = content_type or 'application/octet-stream'
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


class RenderJobDownloadView(APIView):
    """
    Stream the output files of a completed render job as a ZIP archive.

    This replaces the client-side ZIP assembly (JSZip + canvas re-render) with a
    lightweight server-side stream, eliminating the CPU/RAM spike on low-end devices.

    GET /api/jobs/<job_id>/download/[?content=all|print|mock|uploads]

    ``content`` selects WHICH part of the job is packaged, so a caller that
    stores mock and print artefacts in separate fields (printo.in does) can
    fetch each one directly instead of receiving one archive and splitting it:

      all      (default) — the original three-folder archive:
                           1_customer_uploads/, 2_mock/, 3_print/
      print    — the 300 DPI print files only, at the archive root
      mock     — the small web preview JPEGs only, at the archive root
      uploads  — the customer's original photos only, at the archive root

    ``all`` is the default and its layout is unchanged, so existing callers
    reading ``download_url`` keep working byte-for-byte.
    """
    permission_classes = [IsAuthenticatedWithAPIKey, CanAccessExports]

    #: Valid ?content= values. 'all' must stay the default for back-compat.
    CONTENT_CHOICES = ('all', 'print', 'mock', 'uploads')

    @extend_schema(
        tags=["exports"],
        summary="Download completed job output as ZIP",
        description=(
            "Streams output files for a completed render job as a ZIP archive. "
            "Use `content` to fetch one part on its own (print / mock / uploads) "
            "instead of the combined archive. Returns 409 if the job has not yet "
            "completed."
        ),
        parameters=[
            OpenApiParameter(
                "content", OpenApiTypes.STR, OpenApiParameter.QUERY,
                enum=list(CONTENT_CHOICES),
                description=(
                    "Which part to package. `all` (default) returns the combined "
                    "1_customer_uploads/ + 2_mock/ + 3_print/ archive; the others "
                    "return just that part, flat at the archive root."
                ),
            ),
            OpenApiParameter(
                "include_uploads", OpenApiTypes.BOOL, OpenApiParameter.QUERY,
                description=(
                    "Include the customer's original photos. Defaults to true. "
                    "Ignored when `content` is `print` or `mock`."
                ),
            ),
        ],
        responses={
            200: OpenApiResponse(description="application/zip binary stream"),
            400: OpenApiResponse(description="Invalid content parameter"),
            404: OpenApiResponse(description="Job not found or no matching files"),
            409: OpenApiResponse(description="Job not yet completed"),
        },
    )
    def get(self, request, job_id):
        import io
        import zipfile
        import tempfile
        from django.http import FileResponse
        from PIL import Image
        from api.models import RenderJob, UploadedFile

        try:
            job = RenderJob.objects.select_related('canvas_data').get(id=job_id)
        except RenderJob.DoesNotExist:
            return Response({'detail': 'Job not found'}, status=status.HTTP_404_NOT_FOUND)

        # Ownership check: APIKeyUsers may only download their own jobs.
        if isinstance(request.user, APIKeyUser):
            if job.canvas_data.api_key != request.user.api_key:
                return Response({'detail': 'Job not found'}, status=status.HTTP_404_NOT_FOUND)

        if job.status != 'completed':
            return Response(
                {'detail': f'Job is not completed yet (status: {job.status})'},
                status=status.HTTP_409_CONFLICT,
            )

        if not job.output_paths:
            return Response(
                {'detail': 'No output files available for this job'},
                status=status.HTTP_404_NOT_FOUND,
            )

        content = str(request.query_params.get('content', 'all')).strip().lower() or 'all'
        if content not in self.CONTENT_CHOICES:
            return Response(
                {'detail': f"content must be one of: {', '.join(self.CONTENT_CHOICES)}"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        want_print = content in ('all', 'print')
        want_mock = content in ('all', 'mock')

        # ── 3_print/ — high-res 300 DPI render output ──────────────────────
        # Path-traversal guard: every path must resolve inside EXPORTS_DIR.
        exports_root = os.path.realpath(settings.EXPORTS_DIR)
        safe_print_paths = []
        for raw_path in job.output_paths:
            resolved = os.path.realpath(raw_path)
            if resolved.startswith(exports_root + os.sep) and os.path.isfile(resolved):
                safe_print_paths.append(resolved)
            else:
                logger.warning("RenderJobDownloadView: blocked print path %s for job %s", raw_path, job_id)

        # Only fatal when the caller actually wants render output — a
        # ?content=uploads fetch is still serviceable without it.
        if not safe_print_paths and (want_print or want_mock):
            return Response(
                {'detail': 'No accessible output files found on disk'},
                status=status.HTTP_404_NOT_FOUND,
            )

        # ── 1_customer_uploads/ — original images the customer uploaded ────
        # `CanvasData.image_paths` is the JSON list of file paths recorded at
        # submission time (UploadedFile.file_path entries). Restore the
        # human-readable filename from UploadedFile.original_filename when
        # available — file_path uses a sanitised hash-prefixed name on disk.
        # Included only when the caller opts in (?include_uploads=1). The
        # dashboard "Ready to download" modal leaves this OFF by default: the
        # raw originals are the biggest, slowest part of the archive and ops
        # rarely needs them, so excluding them makes the download much faster.
        # An ABSENT param defaults to true, so the embed webhook consumer keeps
        # its existing contract (it fetches download_url with no query string).
        canvas = job.canvas_data
        include_uploads = str(
            request.query_params.get('include_uploads', 'true')
        ).strip().lower() not in ('0', 'false', 'no', 'off')
        want_uploads = include_uploads and content in ('all', 'uploads')
        safe_upload_entries: list[tuple[str, str]] = []  # (resolved_path, arcname_basename)
        if want_uploads:
            uploads_root = os.path.realpath(settings.UPLOADS_DIR)
            upload_records = {
                uf.file_path: uf.original_filename
                for uf in UploadedFile.objects.filter(
                    file_path__in=(canvas.image_paths or []),
                    is_deleted=False,
                )
            }
            for raw_path in (canvas.image_paths or []):
                resolved = os.path.realpath(raw_path)
                if not resolved.startswith(uploads_root + os.sep):
                    logger.warning("RenderJobDownloadView: blocked upload path %s for job %s", raw_path, job_id)
                    continue
                if not os.path.isfile(resolved):
                    # File may have been GC'd or deleted; skip gracefully.
                    logger.info("Upload missing on disk for job %s: %s", job_id, raw_path)
                    continue
                arcname_basename = upload_records.get(raw_path) or os.path.basename(resolved)
                safe_upload_entries.append((resolved, arcname_basename))

        # ── 2_mock/ — downscaled web-friendly previews of the print files ──
        # Mocks are pre-generated at render time as a JPEG sibling next to
        # each print file (see `_write_output_atomic` in layout_engine).
        # We just bundle them here — no CPU work at download time. The
        # on-the-fly fallback below covers older jobs rendered before the
        # render-time mock generation landed; can be removed once those
        # have aged out via GC.
        # Settings mirror engine.py — keep in sync.
        MOCK_LONG_EDGE = 600
        MOCK_QUALITY = 70

        def _build_mock_jpeg_bytes(print_path: str) -> bytes | None:
            """Fallback for older jobs that don't have a mock sibling on disk."""
            try:
                with Image.open(print_path) as im:
                    im.load()
                    if im.format not in ('PNG', 'JPEG', 'JPG', 'TIFF', 'WEBP'):
                        return None
                    rgb = im.convert('RGB')
                    rgb.thumbnail(
                        (MOCK_LONG_EDGE, MOCK_LONG_EDGE),
                        Image.Resampling.LANCZOS,
                    )
                    buf = io.BytesIO()
                    rgb.save(buf, format='JPEG', quality=MOCK_QUALITY)
                    return buf.getvalue()
            except Exception as exc:
                logger.warning(
                    "RenderJobDownloadView: fallback mock generation failed for %s: %s",
                    print_path, exc,
                )
                return None

        # Build the ZIP on disk in a temp file living under EXPORTS_DIR (same
        # filesystem as the source files; lets the OS use sendfile for the read
        # back). This replaces the previous io.BytesIO buffer that pinned the
        # entire archive in worker memory — a 200-PNG render could push 500 MB
        # per concurrent download. Streaming from disk via FileResponse keeps
        # worker RAM flat regardless of archive size.
        # PNG files are already DEFLATE-compressed — ZIP_STORED skips the
        # redundant pass and saves CPU for marginal size savings.
        # Human-friendly, short download name: the layout name plus an 8-char
        # job suffix. The full job UUID produced an unwieldy 40-char filename
        # ("job-e557aa7d-3d4f-…-50e9c43bef23.zip"); the short suffix keeps the
        # name compact while still disambiguating repeated downloads of the
        # same layout. layout_name is sanitised for safe use in the
        # Content-Disposition header.
        if content == 'uploads' and not safe_upload_entries:
            return Response(
                {'detail': 'No customer uploads are available for this job'},
                status=status.HTTP_404_NOT_FOUND,
            )

        safe_layout = re.sub(r'[^A-Za-z0-9_.\-]+', '-', (canvas.layout_name or 'design')).strip('-._') or 'design'
        # Single-part archives carry the part in the filename so a caller
        # saving all three doesn't end up with three identically-named files.
        suffix = '' if content == 'all' else f'-{content}'
        zip_name = f"{safe_layout[:48]}-{str(job_id)[:8]}{suffix}.zip"

        # The combined archive keeps its three numbered folders (existing
        # callers extract by that path); a single-part archive puts its files
        # flat at the root, where a folder of one kind would be noise.
        def arcname(folder: str, basename: str) -> str:
            return f'{folder}/{basename}' if content == 'all' else basename
        tmp = tempfile.NamedTemporaryFile(
            mode='w+b', suffix='.zip', delete=False, dir=exports_root,
        )
        mock_count = 0
        try:
            with zipfile.ZipFile(tmp, mode='w', compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
                # 1_customer_uploads/ — original photos as customer named them
                for path, original_name in safe_upload_entries:
                    zf.write(path, arcname=arcname('1_customer_uploads', original_name))

                # 2_mock/ + 3_print/ — paired by index from the print list
                for print_path in safe_print_paths:
                    print_basename = os.path.basename(print_path)
                    if want_print:
                        zf.write(print_path, arcname=arcname('3_print', print_basename))

                    if not want_mock:
                        continue

                    # Prefer the pre-generated sibling JPEG (cheap path).
                    # Falls back to on-the-fly downscaling for legacy jobs
                    # rendered before the engine started writing siblings.
                    stem = os.path.splitext(print_basename)[0]
                    mock_name = f'{stem}_preview.jpg'
                    sibling_mock = os.path.splitext(print_path)[0] + '_preview.jpg'
                    sibling_mock_real = os.path.realpath(sibling_mock)
                    if (
                        os.path.isfile(sibling_mock_real)
                        and sibling_mock_real.startswith(exports_root + os.sep)
                    ):
                        zf.write(sibling_mock_real, arcname=arcname('2_mock', mock_name))
                        mock_count += 1
                    else:
                        mock_bytes = _build_mock_jpeg_bytes(print_path)
                        if mock_bytes is not None:
                            zf.writestr(
                                arcname('2_mock', mock_name),
                                mock_bytes,
                                compress_type=zipfile.ZIP_STORED,
                            )
                            mock_count += 1
            tmp.flush()
            zip_size = os.fstat(tmp.fileno()).st_size
            tmp.seek(0)
        except Exception:
            tmp.close()
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
            raise

        # A mock-only archive with nothing in it is a failure, not an empty
        # success — the caller asked for previews and would otherwise store a
        # valid-looking 22-byte ZIP against the order.
        if content == 'mock' and mock_count == 0:
            tmp.close()
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
            logger.warning("No mock previews could be produced for job %s", job_id)
            return Response(
                {'detail': 'No preview images are available for this job'},
                status=status.HTTP_404_NOT_FOUND,
            )

        api_key = request.user.api_key if isinstance(request.user, APIKeyUser) else None
        if api_key:
            logger.info(
                "Job ZIP downloaded: job=%s content=%s uploads=%d mocks=%d prints=%d size=%d by %s",
                job_id, content, len(safe_upload_entries), mock_count,
                len(safe_print_paths) if want_print else 0, zip_size, api_key.name,
            )

        # FileResponse streams in chunks (8 KB by default) and closes the file
        # when the response ends. Wire a close hook to unlink the temp file so
        # the disk doesn't fill up with stale archives.
        response = FileResponse(
            tmp, as_attachment=True, filename=zip_name, content_type='application/zip',
        )
        response['Content-Length'] = zip_size

        _tmp_path = tmp.name
        original_close = response.close
        def _cleanup_close():
            try:
                original_close()
            finally:
                try:
                    os.unlink(_tmp_path)
                except OSError:
                    pass
        response.close = _cleanup_close
        return response
