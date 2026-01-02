#!/bin/bash
# Quick test script to simulate Railway environment locally
# Usage: ./scripts/test-railway-env.sh [scenario]
#
# Scenarios:
#   railway    - Simulate Railway production deployment
#   dev        - Simulate local development
#   prod-fail  - Simulate production without proper config (should fail)
#   custom     - Use custom explicit TANDA_REDIRECT_URI

set -e

SCENARIO="${1:-railway}"

echo "🧪 Testing environment configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Base credentials for testing
export TANDA_CLIENT_ID="test-client-id"
export TANDA_CLIENT_SECRET="test-client-secret"
export SESSION_SECRET="test-session-secret-must-be-at-least-32-chars"
export JWT_SECRET="test-jwt-secret-must-be-at-least-32-characters"

case "$SCENARIO" in
  railway)
    echo "📦 Scenario: Railway Production"
    echo "   Simulating RAILWAY_PUBLIC_DOMAIN=myapp.up.railway.app"
    echo ""
    export NODE_ENV=production
    export RAILWAY_PUBLIC_DOMAIN="myapp.up.railway.app"
    unset TANDA_REDIRECT_URI
    ;;

  railway-static)
    echo "📦 Scenario: Railway with RAILWAY_STATIC_URL"
    echo "   Simulating RAILWAY_STATIC_URL=https://custom.railway.app"
    echo ""
    export NODE_ENV=production
    export RAILWAY_PUBLIC_DOMAIN="myapp.up.railway.app"
    export RAILWAY_STATIC_URL="https://custom.railway.app"
    unset TANDA_REDIRECT_URI
    ;;

  dev)
    echo "💻 Scenario: Local Development"
    echo "   No Railway vars, expecting localhost fallback"
    echo ""
    export NODE_ENV=development
    unset RAILWAY_PUBLIC_DOMAIN
    unset RAILWAY_STATIC_URL
    unset TANDA_REDIRECT_URI
    ;;

  prod-fail)
    echo "❌ Scenario: Production without config (SHOULD FAIL)"
    echo "   No Railway vars, no explicit URI - expect exit code 1"
    echo ""
    export NODE_ENV=production
    unset RAILWAY_PUBLIC_DOMAIN
    unset RAILWAY_STATIC_URL
    unset TANDA_REDIRECT_URI
    ;;

  custom)
    echo "🔧 Scenario: Custom Explicit URI"
    echo "   Using TANDA_REDIRECT_URI=https://custom-domain.com/auth/callback"
    echo ""
    export NODE_ENV=production
    export RAILWAY_PUBLIC_DOMAIN="myapp.up.railway.app"
    export TANDA_REDIRECT_URI="https://custom-domain.com/auth/callback"
    ;;

  *)
    echo "Unknown scenario: $SCENARIO"
    echo "Available: railway, railway-static, dev, prod-fail, custom"
    exit 1
    ;;
esac

echo "Environment variables set:"
echo "  NODE_ENV=$NODE_ENV"
echo "  RAILWAY_PUBLIC_DOMAIN=${RAILWAY_PUBLIC_DOMAIN:-<not set>}"
echo "  RAILWAY_STATIC_URL=${RAILWAY_STATIC_URL:-<not set>}"
echo "  TANDA_REDIRECT_URI=${TANDA_REDIRECT_URI:-<not set>}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Starting server (will show config and exit after 3 seconds)..."
echo ""

# Run the server with a timeout
timeout 3s node dist/index.js 2>&1 || true

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Test complete for scenario: $SCENARIO"
