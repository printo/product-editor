"""
Tests for AI Service Failure Handling
Tests comprehensive error handling, graceful degradation, and manual override options
"""
import unittest
from unittest.mock import Mock, patch, MagicMock
import tempfile
import os
from datetime import datetime, timedelta
from PIL import Image
import numpy as np

from django.test import TestCase
from django.core.files.uploadedfile import SimpleUploadedFile

from ai_engine.failure_handler import (
    AIServiceFailureHandler, FailureType, FallbackStrategy, 
    FailureContext, FallbackResult
)
from ai_engine.background_processor import (
    BackgroundProcessor, BackgroundJob, JobStatus, JobPriority
)
from ai_engine.background_removal import BackgroundRemovalService, ProcessingResult
from ai_engine.product_detection import ProductDetectionService, DetectedProduct, BoundingBox


class TestAIServiceFailureHandler(TestCase):
    """Test AI service failure handling functionality"""
    
    def setUp(self):
        self.failure_handler = AIServiceFailureHandler()
        
    def test_failure_classification(self):
        """Test error classification for different failure types"""
        
        # Test model unavailable error
        model_error = Exception("Model not found")
        failure_type = self.failure_handler._classify_error(model_error)
        self.assertEqual(failure_type, FailureType.MODEL_UNAVAILABLE)
        
        # Test timeout error
        timeout_error = Exception("Operation timeout")
        failure_type = self.failure_handler._classify_error(timeout_error)
        self.assertEqual(failure_type, FailureType.TIMEOUT)
        
        # Test resource exhausted error
        memory_error = Exception("Out of memory")
        failure_type = self.failure_handler._classify_error(memory_error)
        self.assertEqual(failure_type, FailureType.RESOURCE_EXHAUSTED)
        
        # Test invalid input error
        input_error = Exception("Invalid image format")
        failure_type = self.failure_handler._classify_error(input_error)
        self.assertEqual(failure_type, FailureType.INVALID_INPUT)
    
    def test_fallback_strategy_determination(self):
        """Test fallback strategy selection based on failure context"""
        
        # Test timeout failure -> queue for retry
        timeout_context = FailureContext(
            failure_type=FailureType.TIMEOUT,
            service_name='background_removal',
            error_message='Timeout',
            timestamp=datetime.now()
        )
        strategy = self.failure_handler._determine_fallback_strategy(timeout_context)
        self.assertEqual(strategy, FallbackStrategy.QUEUE_FOR_RETRY)
        
        # Test model unavailable -> manual processing
        model_context = FailureContext(
            failure_type=FailureType.MODEL_UNAVAILABLE,
            service_name='product_detection',
            error_message='Model not available',
            timestamp=datetime.now()
        )
        strategy = self.failure_handler._determine_fallback_strategy(model_context)
        self.assertEqual(strategy, FallbackStrategy.MANUAL_PROCESSING)
    
    def test_circuit_breaker_functionality(self):
        """Test circuit breaker opens and closes correctly"""
        
        service_name = 'test_service'
        
        # Initially circuit should be closed
        self.assertFalse(self.failure_handler._is_circuit_open(service_name))
        
        # Increment failures up to threshold
        threshold = self.failure_handler.circuit_breaker_thresholds.get(service_name, 5)
        for i in range(threshold):
            self.failure_handler._increment_failure_count(service_name)
        
        # Circuit should now be open
        self.assertTrue(self.failure_handler._is_circuit_open(service_name))
        
        # Reset should close circuit
        self.failure_handler._reset_failure_count(service_name)
        self.assertFalse(self.failure_handler._is_circuit_open(service_name))
    
    def test_manual_processing_fallback(self):
        """Test manual processing fallback provides appropriate options"""
        
        context = FailureContext(
            failure_type=FailureType.MODEL_UNAVAILABLE,
            service_name='background_removal',
            error_message='Model unavailable',
            timestamp=datetime.now()
        )
        
        result = self.failure_handler._fallback_to_manual(context)
        
        self.assertIsInstance(result, FallbackResult)
        self.assertFalse(result.success)
        self.assertEqual(result.strategy_used, FallbackStrategy.MANUAL_PROCESSING)
        self.assertTrue(result.manual_override_available)
        self.assertIsNotNone(result.suggested_actions)
        self.assertGreater(len(result.suggested_actions), 0)
    
    def test_simplified_ai_fallback(self):
        """Test simplified AI fallback for design placement"""
        
        # Create mock design and product bounds
        mock_design = Mock()
        mock_design.width = 100
        mock_design.height = 100
        
        mock_bounds = Mock()
        mock_bounds.x = 50
        mock_bounds.y = 50
        mock_bounds.width = 200
        mock_bounds.height = 200
        
        result = self.failure_handler._simple_design_placement(mock_design, mock_bounds)
        
        self.assertIsInstance(result, FallbackResult)
        self.assertTrue(result.success)
        self.assertEqual(result.strategy_used, FallbackStrategy.SIMPLIFIED_AI)
        self.assertIsNotNone(result.result_data)
    
    @patch('ai_engine.failure_handler.threading.Thread')
    def test_timeout_handling(self, mock_thread):
        """Test timeout handling with threading"""
        
        # Mock a function that takes too long
        def slow_function():
            import time
            time.sleep(2)
            return "result"
        
        # Mock thread behavior
        mock_thread_instance = Mock()
        mock_thread_instance.is_alive.return_value = True
        mock_thread.return_value = mock_thread_instance
        
        with self.assertRaises(TimeoutError):
            self.failure_handler._execute_with_timeout(slow_function, 1)


class TestBackgroundProcessor(TestCase):
    """Test background processing functionality"""
    
    def setUp(self):
        self.processor = BackgroundProcessor(max_workers=1)
        
    def tearDown(self):
        if self.processor.running:
            self.processor.stop()
    
    def test_job_queuing(self):
        """Test job queuing functionality"""
        
        # Register a test function
        def test_function(x, y):
            return x + y
        
        self.processor.register_service_function('test_service', 'add', test_function)
        
        # Queue a job
        job_id = self.processor.queue_job(
            'test_service', 'add', 5, 3,
            priority=JobPriority.NORMAL
        )
        
        self.assertIsNotNone(job_id)
        
        # Check job status
        job = self.processor.get_job_status(job_id)
        self.assertIsNotNone(job)
        self.assertEqual(job.status, JobStatus.QUEUED)
    
    def test_job_processing(self):
        """Test job processing with worker threads"""
        
        # Register a simple test function
        def test_function(value):
            return value * 2
        
        self.processor.register_service_function('test_service', 'double', test_function)
        
        # Start processor
        self.processor.start()
        
        # Queue a job
        job_id = self.processor.queue_job('test_service', 'double', 21)
        
        # Wait a bit for processing
        import time
        time.sleep(0.5)
        
        # Check job completed
        job = self.processor.get_job_status(job_id)
        self.assertIsNotNone(job)
        # Job should be completed or processing
        self.assertIn(job.status, [JobStatus.COMPLETED, JobStatus.PROCESSING])
    
    def test_job_retry_mechanism(self):
        """Test job retry on failure"""
        
        # Register a function that fails initially
        call_count = [0]
        
        def failing_function():
            call_count[0] += 1
            if call_count[0] < 3:
                raise Exception("Temporary failure")
            return "success"
        
        self.processor.register_service_function('test_service', 'fail_then_succeed', failing_function)
        
        # Queue job with retries
        job_id = self.processor.queue_job(
            'test_service', 'fail_then_succeed',
            max_retries=3
        )
        
        # Start processor
        self.processor.start()
        
        # Wait for processing and retries
        import time
        time.sleep(2)
        
        # Job should eventually succeed
        job = self.processor.get_job_status(job_id)
        self.assertIsNotNone(job)
        # Should have retried and succeeded
        self.assertGreaterEqual(job.retry_count, 1)


class TestBackgroundRemovalFailureHandling(TestCase):
    """Test background removal service failure handling"""
    
    def setUp(self):
        self.service = BackgroundRemovalService()
        
    def create_test_image(self):
        """Create a test image file"""
        img = Image.new('RGB', (100, 100), color='red')
        temp_file = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False)
        img.save(temp_file.name)
        return temp_file.name
    
    def tearDown(self):
        # Clean up any test files
        pass
    
    @patch('ai_engine.background_removal.get_model_manager')
    def test_service_unavailable_handling(self, mock_model_manager):
        """Test handling when background removal service is unavailable"""
        
        # Mock model manager to simulate service unavailability
        mock_manager = Mock()
        mock_manager.get_model_status.return_value.is_healthy = False
        mock_model_manager.return_value = mock_manager
        
        # Test service availability check
        self.assertFalse(self.service.is_available())
    
    def test_manual_override_options(self):
        """Test manual override options are provided"""
        
        options = self.service.get_manual_override_options()
        
        self.assertIsInstance(options, dict)
        self.assertTrue(options['available'])
        self.assertIn('options', options)
        self.assertGreater(len(options['options']), 0)
        
        # Check first option has required fields
        first_option = options['options'][0]
        self.assertIn('name', first_option)
        self.assertIn('display_name', first_option)
        self.assertIn('description', first_option)
    
    @patch('ai_engine.background_removal.get_background_processor')
    def test_background_processing_queue(self, mock_processor):
        """Test queuing for background processing"""
        
        # Mock background processor
        mock_bg_processor = Mock()
        mock_bg_processor.queue_job.return_value = 'test-job-id'
        mock_processor.return_value = mock_bg_processor
        
        test_image = self.create_test_image()
        
        try:
            result = self.service._queue_for_background_processing(test_image, user_id='test_user')
            
            self.assertIsInstance(result, ProcessingResult)
            self.assertFalse(result.success)  # Not completed yet
            self.assertEqual(result.background_job_id, 'test-job-id')
            self.assertTrue(result.manual_override_available)
            
        finally:
            os.unlink(test_image)
    
    def test_background_job_status_checking(self):
        """Test background job status checking"""
        
        # Mock a background job
        mock_job = Mock()
        mock_job.status.value = 'processing'
        mock_job.created_at = datetime.now()
        mock_job.started_at = datetime.now()
        mock_job.completed_at = None
        mock_job.retry_count = 0
        
        with patch.object(self.service.background_processor, 'get_job_status', return_value=mock_job):
            status = self.service.check_background_job_status('test-job-id')
            
            self.assertIsInstance(status, dict)
            self.assertEqual(status['status'], 'processing')
            self.assertIn('progress', status)
            self.assertIn('estimated_completion', status)


class TestProductDetectionFailureHandling(TestCase):
    """Test product detection service failure handling"""
    
    def setUp(self):
        self.service = ProductDetectionService()
    
    def test_manual_override_options(self):
        """Test manual override options for product detection"""
        
        options = self.service.get_manual_override_options()
        
        self.assertIsInstance(options, dict)
        self.assertTrue(options['available'])
        self.assertIn('options', options)
        
        # Should have manual selection option
        manual_option = next(
            (opt for opt in options['options'] if opt['name'] == 'manual_selection'),
            None
        )
        self.assertIsNotNone(manual_option)
        self.assertIn('instructions', manual_option)
    
    def test_manual_product_creation(self):
        """Test creating manual product detection results"""
        
        bounds = {'x': 100, 'y': 100, 'width': 200, 'height': 200}
        product = self.service.create_manual_product('shirt', bounds, confidence=0.9)
        
        self.assertIsInstance(product, DetectedProduct)
        self.assertEqual(product.category, 'shirt')
        self.assertEqual(product.confidence, 0.9)
        self.assertEqual(product.bounding_box.x, 100)
        self.assertEqual(product.bounding_box.y, 100)
        self.assertEqual(product.bounding_box.width, 200)
        self.assertEqual(product.bounding_box.height, 200)
    
    def test_detection_suggestions(self):
        """Test detection suggestions for manual override"""
        
        # Create a test image
        img = Image.new('RGB', (400, 600), color='blue')  # Portrait orientation
        temp_file = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False)
        img.save(temp_file.name)
        
        try:
            suggestions = self.service.get_detection_suggestions(temp_file.name)
            
            self.assertIsInstance(suggestions, dict)
            self.assertIn('image_info', suggestions)
            self.assertIn('suggested_areas', suggestions)
            
            # Should suggest areas for portrait image
            self.assertEqual(suggestions['image_info']['orientation'], 'portrait')
            self.assertGreater(len(suggestions['suggested_areas']), 0)
            
        finally:
            os.unlink(temp_file.name)


class TestIntegrationFailureHandling(TestCase):
    """Integration tests for AI failure handling across services"""
    
    def test_complete_failure_workflow(self):
        """Test complete failure handling workflow from API to fallback"""
        
        # This would test the full workflow:
        # 1. API receives request
        # 2. AI service fails
        # 3. Failure handler provides fallback
        # 4. Manual override options are returned
        # 5. Background processing is queued if appropriate
        
        # Mock the entire chain
        with patch('ai_engine.background_removal.get_model_manager') as mock_manager:
            mock_manager.return_value.load_model.side_effect = Exception("Model unavailable")
            
            service = BackgroundRemovalService()
            
            # Create test image
            img = Image.new('RGB', (100, 100), color='red')
            temp_file = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False)
            img.save(temp_file.name)
            
            try:
                result = service.remove_background(temp_file.name)
                
                # Should fail but provide fallback options
                self.assertFalse(result.success)
                self.assertTrue(result.manual_override_available)
                self.assertIsNotNone(result.suggested_actions)
                
            finally:
                os.unlink(temp_file.name)
    
    def test_service_status_reporting(self):
        """Test comprehensive service status reporting"""
        
        failure_handler = AIServiceFailureHandler()
        
        # Simulate some failures
        failure_handler._increment_failure_count('background_removal')
        failure_handler._increment_failure_count('product_detection')
        
        status = failure_handler.get_service_status()
        
        self.assertIsInstance(status, dict)
        self.assertIn('background_removal', status)
        self.assertIn('product_detection', status)
        
        # Check status structure
        bg_status = status['background_removal']
        self.assertIn('failure_count', bg_status)
        self.assertIn('threshold', bg_status)
        self.assertIn('circuit_open', bg_status)
        self.assertIn('status', bg_status)


if __name__ == '__main__':
    unittest.main()