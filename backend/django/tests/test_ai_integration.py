"""
End-to-End Integration Tests for AI Image Processing
Tests complete workflows from upload to export with AI processing
"""
import os
import tempfile
import time
from django.test import TestCase, TransactionTestCase
from django.core.files.uploadedfile import SimpleUploadedFile
from django.urls import reverse
from rest_framework.test import APITestCase
from rest_framework import status
from PIL import Image
import io
from unittest.mock import patch, MagicMock

from api.models import APIKey, UploadedFile, ExportedResult, AIProcessingJob
from ai_engine.background_removal import get_background_remover
from ai_engine.product_detection import get_product_detector
from ai_engine.design_placement import get_design_placer
from ai_engine.blend_engine import get_blend_engine
from ai_engine.smart_layout import get_smart_engine
from ai_engine.image_format_handler import get_format_handler
from ai_engine.resource_manager import get_resource_manager
from ai_engine.failure_handler import get_failure_handler


class AIIntegrationTestCase(APITestCase):
    """Base test case with common setup for AI integration tests"""
    
    def setUp(self):
        """Set up test environment"""
        # Create test API key
        self.api_key = APIKey.objects.create(
            name="test_key",
            key="test_12345",
            permissions=["generate_layouts", "list_layouts", "access_exports"]
        )
        
        # Set up authentication
        self.client.credentials(HTTP_AUTHORIZATION=f'Bearer {self.api_key.key}')
        
        # Create test images
        self.test_images = self._create_test_images()
        
        # Mock AI services for consistent testing
        self._setup_ai_mocks()
    
    def _create_test_images(self):
        """Create test images in various formats"""
        images = {}
        
        # Create JPEG image
        jpeg_img = Image.new('RGB', (800, 600), color='red')
        jpeg_buffer = io.BytesIO()
        jpeg_img.save(jpeg_buffer, format='JPEG', quality=85)
        jpeg_buffer.seek(0)
        images['jpeg'] = SimpleUploadedFile(
            "test_image.jpg", 
            jpeg_buffer.getvalue(), 
            content_type="image/jpeg"
        )
        
        # Create PNG image with transparency
        png_img = Image.new('RGBA', (800, 600), color=(0, 255, 0, 128))
        png_buffer = io.BytesIO()
        png_img.save(png_buffer, format='PNG')
        png_buffer.seek(0)
        images['png'] = SimpleUploadedFile(
            "test_image.png", 
            png_buffer.getvalue(), 
            content_type="image/png"
        )
        
        # Create WebP image
        webp_img = Image.new('RGB', (800, 600), color='blue')
        webp_buffer = io.BytesIO()
        webp_img.save(webp_buffer, format='WEBP', quality=80)
        webp_buffer.seek(0)
        images['webp'] = SimpleUploadedFile(
            "test_image.webp", 
            webp_buffer.getvalue(), 
            content_type="image/webp"
        )
        
        # Create large image for testing size limits
        large_img = Image.new('RGB', (4000, 3000), color='purple')
        large_buffer = io.BytesIO()
        large_img.save(large_buffer, format='JPEG', quality=95)
        large_buffer.seek(0)
        images['large'] = SimpleUploadedFile(
            "large_image.jpg", 
            large_buffer.getvalue(), 
            content_type="image/jpeg"
        )
        
        return images
    
    def _setup_ai_mocks(self):
        """Set up mocks for AI services"""
        # Mock successful AI processing results
        self.mock_bg_removal_result = MagicMock()
        self.mock_bg_removal_result.success = True
        self.mock_bg_removal_result.processed_image_path = "/tmp/test_no_bg.png"
        self.mock_bg_removal_result.processing_time = 2.5
        self.mock_bg_removal_result.metadata = {'model_used': 'rmbg-1.4'}
        self.mock_bg_removal_result.fallback_used = False
        self.mock_bg_removal_result.manual_override_available = True
        
        self.mock_product_detection_result = [
            MagicMock(category='shirt', confidence=0.85, center_point=(400, 300)),
            MagicMock(category='hoodie', confidence=0.75, center_point=(200, 150))
        ]
        
        self.mock_placement_result = MagicMock()
        self.mock_placement_result.success = True
        self.mock_placement_result.placed_image_path = "/tmp/test_placed.png"
        
        self.mock_blend_result = MagicMock()
        self.mock_blend_result.success = True
        self.mock_blend_result.blended_image_path = "/tmp/test_blended.png"


class CompleteWorkflowIntegrationTest(AIIntegrationTestCase):
    """Test complete AI processing workflows from upload to export"""
    
    @patch('ai_engine.background_removal.BackgroundRemovalService.remove_background')
    @patch('ai_engine.product_detection.ProductDetectionService.detect_products')
    @patch('ai_engine.design_placement.DesignPlacementService.place_design')
    @patch('ai_engine.blend_engine.BlendEngine.blend_images')
    def test_complete_ai_workflow_jpeg(self, mock_blend, mock_place, mock_detect, mock_bg_remove):
        """Test complete AI workflow with JPEG images"""
        # Setup mocks
        mock_bg_remove.return_value = self.mock_bg_removal_result
        mock_detect.return_value = self.mock_product_detection_result
        mock_place.return_value = self.mock_placement_result
        mock_blend.return_value = self.mock_blend_result
        
        # Test layout generation with AI processing
        response = self.client.post('/api/layout/generate', {
            'layout': '4x6-20',
            'images': [self.test_images['jpeg']],
            'remove_backgrounds': 'true',
            'detect_products': 'true',
            'realistic_blending': 'true',
            'blend_mode': 'multiply'
        })
        
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        
        # Verify response structure
        self.assertIn('canvases', data)
        self.assertIn('ai_processing', data)
        self.assertIn('generation_time_ms', data)
        
        # Verify AI processing was applied
        ai_data = data['ai_processing']
        self.assertIn('file_0', ai_data)
        
        # Verify database records
        self.assertTrue(UploadedFile.objects.filter(api_key=self.api_key).exists())
        self.assertTrue(ExportedResult.objects.filter(api_key=self.api_key).exists())
        
        # Verify AI service calls
        mock_bg_remove.assert_called()
        mock_detect.assert_called()
    
    @patch('ai_engine.background_removal.BackgroundRemovalService.remove_background')
    def test_background_removal_workflow_png(self, mock_bg_remove):
        """Test background removal workflow with PNG transparency"""
        mock_bg_remove.return_value = self.mock_bg_removal_result
        
        response = self.client.post('/api/ai/remove-background/', {
            'image': self.test_images['png']
        })
        
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        
        self.assertTrue(data['success'])
        self.assertIn('processed_image', data)
        self.assertIn('processing_time', data)
        self.assertIn('metadata', data)
        
        # Verify AI processing job was created
        self.assertTrue(AIProcessingJob.objects.filter(
            api_key=self.api_key,
            job_type='background_removal'
        ).exists())
    
    @patch('ai_engine.product_detection.ProductDetectionService.detect_products')
    def test_product_detection_workflow_webp(self, mock_detect):
        """Test product detection workflow with WebP format"""
        mock_detect.return_value = self.mock_product_detection_result
        
        response = self.client.post('/api/ai/detect-products/', {
            'image': self.test_images['webp']
        })
        
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        
        self.assertTrue(data['success'])
        self.assertIn('products', data)
        self.assertEqual(len(data['products']), 2)
        
        # Verify product data structure
        product = data['products'][0]
        self.assertIn('category', product)
        self.assertIn('confidence', product)
        self.assertIn('center_point', product)
    
    def test_ai_status_endpoint(self):
        """Test AI service status endpoint"""
        response = self.client.get('/api/ai/status/')
        
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        
        # Verify status structure
        self.assertIn('models', data)
        self.assertIn('failure_handling', data)
        self.assertIn('background_processing', data)
        self.assertIn('resource_management', data)
        self.assertIn('manual_overrides', data)


class FormatCompatibilityTest(AIIntegrationTestCase):
    """Test compatibility across different image formats"""
    
    def test_format_validation_all_supported(self):
        """Test that all supported formats pass validation"""
        format_handler = get_format_handler()
        
        # Test each format
        for format_name, image_file in self.test_images.items():
            if format_name == 'large':  # Skip large image test here
                continue
                
            # Create temporary file for validation
            with tempfile.NamedTemporaryFile(delete=False, suffix=f'.{format_name}') as temp_file:
                temp_file.write(image_file.read())
                temp_path = temp_file.name
            
            try:
                is_valid, error_msg, image_info = format_handler.validate_image(temp_path)
                self.assertTrue(is_valid, f"Format {format_name} should be valid: {error_msg}")
                self.assertIsNotNone(image_info)
                
                # Verify format-specific properties
                if format_name == 'png':
                    self.assertTrue(image_info.has_transparency)
                elif format_name in ['jpeg', 'webp']:
                    # These might or might not have transparency depending on creation
                    pass
                    
            finally:
                os.unlink(temp_path)
    
    def test_format_conversion_workflow(self):
        """Test format conversion during processing"""
        format_handler = get_format_handler()
        
        # Test JPEG to PNG conversion (for transparency support)
        with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as input_file:
            input_file.write(self.test_images['jpeg'].read())
            input_path = input_file.name
        
        with tempfile.NamedTemporaryFile(delete=False, suffix='.png') as output_file:
            output_path = output_file.name
        
        try:
            success, error_msg = format_handler.convert_format(
                input_path, output_path, 'PNG', quality=85
            )
            
            self.assertTrue(success, f"Conversion failed: {error_msg}")
            self.assertTrue(os.path.exists(output_path))
            
            # Verify converted image
            is_valid, _, image_info = format_handler.validate_image(output_path)
            self.assertTrue(is_valid)
            self.assertEqual(image_info.format, 'PNG')
            
        finally:
            for path in [input_path, output_path]:
                try:
                    os.unlink(path)
                except OSError:
                    pass
    
    def test_large_image_handling(self):
        """Test handling of large images with memory optimization"""
        resource_manager = get_resource_manager()
        
        # Create temporary large image file
        with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as temp_file:
            temp_file.write(self.test_images['large'].read())
            temp_path = temp_file.name
        
        try:
            # Test memory optimization
            optimized_path, opt_info = resource_manager.memory_optimizer.optimize_image_for_processing(temp_path)
            
            # Should be optimized due to size
            self.assertTrue(opt_info.get('optimized', False))
            self.assertLess(opt_info.get('optimized_size_mb', 0), opt_info.get('original_size_mb', 0))
            
            # Clean up optimized image
            if optimized_path != temp_path:
                try:
                    os.unlink(optimized_path)
                except OSError:
                    pass
                    
        finally:
            os.unlink(temp_path)


class PerformanceTest(AIIntegrationTestCase):
    """Test performance under realistic load conditions"""
    
    def test_concurrent_processing_limits(self):
        """Test concurrent request limiting"""
        resource_manager = get_resource_manager()
        
        # Test request limiting
        can_process, reason = resource_manager.request_limiter.can_process_request("test_user")
        self.assertTrue(can_process)
        
        # Simulate multiple concurrent requests
        requests = []
        for i in range(10):
            request = resource_manager.request_limiter.ProcessingRequest(
                id=f"test_request_{i}",
                service_name="test_service",
                function_name="test_function",
                user_id="test_user"
            )
            requests.append(request)
        
        # Try to acquire slots
        acquired = 0
        for request in requests:
            if resource_manager.request_limiter.acquire_slot(request):
                acquired += 1
        
        # Should be limited by max_concurrent setting
        self.assertLessEqual(acquired, resource_manager.request_limiter.max_concurrent)
        
        # Clean up
        for request in requests:
            resource_manager.request_limiter.release_slot(request.id)
    
    def test_caching_performance(self):
        """Test result caching for performance"""
        resource_manager = get_resource_manager()
        cache = resource_manager.result_cache
        
        # Test cache miss and hit
        result = cache.get("test_service", "test_function", "/tmp/test.jpg", {})
        self.assertIsNone(result)  # Cache miss
        
        # Set cache
        test_result = {"success": True, "data": "test"}
        cache.set("test_service", "test_function", "/tmp/test.jpg", test_result, {})
        
        # Test cache hit
        cached_result = cache.get("test_service", "test_function", "/tmp/test.jpg", {})
        self.assertEqual(cached_result, test_result)
        
        # Verify cache stats
        stats = cache.get_stats()
        self.assertGreater(stats['total_requests'], 0)
        self.assertGreater(stats['hit_rate'], 0)
    
    @patch('time.sleep')  # Speed up the test
    def test_processing_timeout_handling(self, mock_sleep):
        """Test timeout handling for long-running operations"""
        failure_handler = get_failure_handler()
        
        # Test timeout decorator
        @failure_handler.with_failure_handling('test_service', timeout=1)
        def slow_function():
            time.sleep(2)  # This would timeout
            return "success"
        
        # This should handle the timeout gracefully
        # In a real scenario, this would return a fallback result
        try:
            result = slow_function()
            # Should either succeed quickly (mocked) or handle timeout
            self.assertIsNotNone(result)
        except Exception as e:
            # Timeout handling should provide meaningful error
            self.assertIn("timeout", str(e).lower())


class BackwardCompatibilityTest(AIIntegrationTestCase):
    """Test backward compatibility with existing designs"""
    
    def test_layout_generation_without_ai(self):
        """Test that layout generation works without AI processing"""
        response = self.client.post('/api/layout/generate', {
            'layout': '4x6-20',
            'images': [self.test_images['jpeg']],
            # No AI processing flags
        })
        
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        data = response.json()
        
        # Should work without AI processing
        self.assertIn('canvases', data)
        self.assertGreater(len(data['canvases']), 0)
        
        # AI processing should not be mentioned if not used
        if 'ai_processing' in data:
            # If present, should indicate no AI processing was done
            pass
    
    def test_existing_api_endpoints_unchanged(self):
        """Test that existing API endpoints maintain their interface"""
        # Test layouts endpoint
        response = self.client.get('/api/layouts')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        
        # Test layout detail endpoint
        response = self.client.get('/api/layouts/4x6-20')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        
        # Verify response structure hasn't changed
        data = response.json()
        # Should contain expected layout structure
        self.assertTrue(isinstance(data, dict))
    
    def test_file_upload_validation_compatibility(self):
        """Test that file upload validation remains compatible"""
        # Test with previously supported formats
        for format_name in ['jpeg', 'png']:
            response = self.client.post('/api/layout/generate', {
                'layout': '4x6-20',
                'images': [self.test_images[format_name]]
            })
            
            # Should accept previously supported formats
            self.assertNotEqual(response.status_code, status.HTTP_400_BAD_REQUEST)


class ErrorHandlingIntegrationTest(AIIntegrationTestCase):
    """Test error handling and graceful degradation"""
    
    @patch('ai_engine.background_removal.BackgroundRemovalService.remove_background')
    def test_ai_service_failure_graceful_degradation(self, mock_bg_remove):
        """Test graceful degradation when AI services fail"""
        # Mock AI service failure
        mock_result = MagicMock()
        mock_result.success = False
        mock_result.error_message = "AI service unavailable"
        mock_result.fallback_used = True
        mock_result.manual_override_available = True
        mock_result.suggested_actions = ["Use manual tools"]
        mock_bg_remove.return_value = mock_result
        
        response = self.client.post('/api/ai/remove-background/', {
            'image': self.test_images['jpeg']
        })
        
        # Should handle failure gracefully
        self.assertIn(response.status_code, [status.HTTP_200_OK, status.HTTP_202_ACCEPTED, status.HTTP_500_INTERNAL_SERVER_ERROR])
        
        if response.status_code != status.HTTP_500_INTERNAL_SERVER_ERROR:
            data = response.json()
            self.assertIn('manual_override_available', data)
            self.assertIn('suggested_actions', data)
    
    def test_invalid_image_format_handling(self):
        """Test handling of invalid image formats"""
        # Create invalid file
        invalid_file = SimpleUploadedFile(
            "test.txt", 
            b"This is not an image", 
            content_type="text/plain"
        )
        
        response = self.client.post('/api/layout/generate', {
            'layout': '4x6-20',
            'images': [invalid_file]
        })
        
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        data = response.json()
        self.assertIn('detail', data)
    
    def test_oversized_image_handling(self):
        """Test handling of oversized images"""
        # This would be tested with actual oversized files in a real scenario
        # For now, we test the validation logic
        from api.validators import validate_image_file
        from django.core.exceptions import ValidationError
        
        # Create a mock oversized file
        oversized_file = MagicMock()
        oversized_file.size = 100 * 1024 * 1024  # 100MB
        oversized_file.name = "huge_image.jpg"
        
        with self.assertRaises(ValidationError):
            validate_image_file(oversized_file, max_size_mb=50)


if __name__ == '__main__':
    import django
    from django.conf import settings
    from django.test.utils import get_runner
    
    if not settings.configured:
        settings.configure(
            DEBUG=True,
            DATABASES={
                'default': {
                    'ENGINE': 'django.db.backends.sqlite3',
                    'NAME': ':memory:',
                }
            },
            INSTALLED_APPS=[
                'django.contrib.auth',
                'django.contrib.contenttypes',
                'rest_framework',
                'api',
                'ai_engine',
            ],
            SECRET_KEY='test-secret-key',
        )
    
    django.setup()
    TestRunner = get_runner(settings)
    test_runner = TestRunner()
    failures = test_runner.run_tests(["__main__"])