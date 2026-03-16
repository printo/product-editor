#!/bin/bash

echo "🚀 Starting Product Editor Development Environment"
echo ""

# Start services
echo "📦 Starting services..."
docker-compose up -d

# Wait for services to start
echo "⏳ Waiting for services to start..."
sleep 15

# Show service status
echo ""
echo "📋 Service Status:"
docker-compose ps

echo ""
echo "🌐 Development Access URLs:"
echo "   Frontend:    http://localhost:5004"
echo "   Backend API: http://localhost:8000/api"
echo "   API Docs:    http://localhost:8000/api/docs"
echo "   Admin Panel: http://localhost:8000/admin/django-admin/"
echo "   Database:    localhost:5432"
echo ""

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Show API keys from environment
echo "🔑 Available API Keys (from .env file):"
echo "   Development: ${DEVELOPMENT_API_KEY}"
echo "   Production:  ${PRODUCTION_API_KEY}"
echo "   Testing:     ${TESTING_API_KEY}"

echo ""
echo "✅ Development environment ready!"
echo "   Open http://localhost:5004 to start using the app"
echo "   Use the Development API key above"