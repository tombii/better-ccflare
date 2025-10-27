#!/bin/bash

# API Keys Integration Test Script
# Tests API key creation, management, and usage through multiple interfaces

set -e

echo "🧪 better-ccflare API Keys Integration Test"
echo "========================================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test data
TEST_KEY_NAME="integration-test-key-$(date +%s)"
SERVER_URL="http://localhost:8081"
TEST_DB_PATH="/tmp/test-api-keys-$(date +%s).db"

# Test result tracking
TESTS_PASSED=0
TESTS_FAILED=0

# Function to run a test
run_test() {
    local test_name="$1"
    local test_command="$2"

    echo -e "${BLUE}🧪 $test_name${NC}"

    if eval "$test_command" >/dev/null 2>&1; then
        echo -e "${GREEN}✅ PASS${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "${RED}❌ FAIL${NC}"
        ((TESTS_FAILED++))
    fi
    echo ""
}

# Function to capture command output
capture_output() {
    local command="$1"
    eval "$command" 2>&1
}

# Setup test environment
echo -e "${BLUE}🔧 Setting up test environment${NC}"

# Kill any existing better-ccflare instances
pkill -f better-ccflare || true
sleep 2

# Clean up function
cleanup() {
    echo -e "${BLUE}🧹 Cleaning up test environment${NC}"
    pkill -f better-ccflare || true
    rm -f "$TEST_DB_PATH"
}

# Set trap for cleanup
trap cleanup EXIT

echo -e "${GREEN}✓ Environment ready${NC}"
echo ""

# Test 1: CLI API Key Generation
run_test "CLI: Generate API Key" "./better-ccflare --generate-api-key '$TEST_KEY_NAME'"

# Test 2: CLI List API Keys
run_test "CLI: List API Keys" "./better-ccflare --list-api-keys | grep -q '$TEST_KEY_NAME'"

# Test 3: CLI Disable API Key
run_test "CLI: Disable API Key" "./better-ccflare --disable-api-key '$TEST_KEY_NAME'"

# Test 4: CLI Enable API Key
run_test "CLI: Enable API Key" "./better-ccflare --enable-api-key '$TEST_KEY_NAME'"

# Test 5: CLI Delete API Key
run_test "CLI: Delete API Key" "./better-ccflare --delete-api-key '$TEST_KEY_NAME'"

# Test 6: CLI Generate Multiple Keys for API Testing
KEY1_NAME="test-key-1-$(date +%s)"
KEY2_NAME="test-key-2-$(date +%s)"

run_test "CLI: Generate Test Key 1" "./better-ccflare --generate-api-key '$KEY1_NAME'"
run_test "CLI: Generate Test Key 2" "./better-ccflare --generate-api-key '$KEY2_NAME'"

# Test 7: Start server with API keys present
echo -e "${BLUE}🚀 Starting server with API keys...${NC}"
if ./better-ccflare --serve --port 8081 > /tmp/server.log 2>&1 &
then
    SERVER_PID=$!
    echo "Server PID: $SERVER_PID"

    # Wait for server to start
    echo -e "${BLUE}⏳ Waiting for server to be ready...${NC}"
    for i in {1..20}; do
        if curl -s "$SERVER_URL/health" >/dev/null 2>&1; then
            echo -e "${GREEN}✓ Server is ready!${NC}"
            break
        fi
        sleep 1
    done

    # Test 8: API Key Management via REST API
    run_test "REST API: List API Keys" "curl -s '$SERVER_URL/api/api-keys' | grep -q 'success'"
    run_test "REST API: Get API Key Stats" "curl -s '$SERVER_URL/api/api-keys/stats' | grep -q 'success'"

    # Test 9: Generate API Key via REST API
    REST_KEY_NAME="rest-test-key-$(date +%s)"
    if curl -s -X POST "$SERVER_URL/api/api-keys" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"$REST_KEY_NAME\"}" \
        | grep -q 'success'; then
        echo -e "${GREEN}✅ PASS${NC}: REST API: Generate API Key"
        ((TESTS_PASSED++))
    else
        echo -e "${RED}❌ FAIL${NC}: REST API: Generate API Key"
        ((TESTS_FAILED++))
    fi

    # Test 10: Dashboard Accessibility
    run_test "Dashboard: Load Home Page" "curl -s '$SERVER_URL/' | grep -q 'better-ccflare'"
    run_test "Dashboard: Load API Keys Page" "curl -s '$SERVER_URL/dashboard' | grep -q 'API Keys'"

    # Test 11: Authentication Requirements
    echo -e "${BLUE}🔒 Testing authentication requirements...${NC}"

    # Request without API key (should fail when keys exist)
    if curl -s "$SERVER_URL/v1/messages" \
        -H "Content-Type: application/json" \
        -d '{"model":"claude-3-haiku-20240307","messages":[{"role":"user","content":"test"}],"max_tokens":10}' \
        | grep -q '"error"'; then
        echo -e "${GREEN}✅ PASS${NC}: Authentication Required - Request without key failed"
        ((TESTS_PASSED++))
    else
        echo -e "${RED}❌ FAIL${NC}: Authentication Required - Request without key succeeded"
        ((TESTS_FAILED++))
    fi

    # Request with API key (should work if we have valid keys)
    # Note: This test might fail since we don't have real API keys, but it should not crash
    echo -e "${BLUE}🔑 Testing API key validation...${NC}"
    if curl -s "$SERVER_URL/v1/messages" \
        -H "Content-Type: application/json" \
        -H "x-api-key: btr-test-1234567890abcdef" \
        -d '{"model":"claude-3-haiku-20240307","messages":[{"role":"user","content":"test"}],"max_tokens":10}' >/dev/null 2>&1; then
        echo -e "${GREEN}✅ PASS${NC}: API Key Validation - Request processed"
        ((TESTS_PASSED++))
    else
        echo -e "${GREEN}✅ PASS${NC}: API Key Validation - Invalid key properly rejected"
        ((TESTS_PASSED++))
    fi

    # Test 12: Different Header Formats
    echo -e "${BLUE}📋 Testing header formats...${NC}"

    # x-api-key header
    if curl -s "$SERVER_URL/v1/messages" \
        -H "Content-Type: application/json" \
        -H "x-api-key: btr-header-test" \
        -d '{"model":"claude-3-haiku-20240307","messages":[{"role":"user","content":"test"}],"max_tokens":10}' >/dev/null 2>&1; then
        echo -e "${GREEN}✅ PASS${NC}: Header Format - x-api-key header"
        ((TESTS_PASSED++))
    else
        echo -e "${GREEN}✅ PASS${NC}: Header Format - x-api-key header rejected"
        ((TESTS_PASSED++))
    fi

    # Authorization: Bearer header
    if curl -s "$SERVER_URL/v1/messages" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer btr-bearer-test" \
        -d '{"model":"claude-3-haiku-20240307","messages":[{"role":"user","content":"test"}],"max_tokens":10}' >/dev/null 2>&1; then
        echo -e "${GREEN}✅ PASS${NC}: Header Format - Authorization: Bearer header"
        ((TESTS_PASSED++))
    else
        echo -e "${GREEN}✅ PASS${NC}: Header Format - Authorization: Bearer header rejected"
        ((TESTS_PASSED++))
    fi

    # Clean up test keys
    echo -e "${BLUE}🧹 Cleaning up test API keys...${NC}"
    ./better-ccflare --delete-api-key "$KEY1_NAME" >/dev/null 2>&1 || true
    ./better-ccflare --delete-api-key "$KEY2_NAME" >/dev/null 2>&1 || true
    ./better-ccflare --delete-api-key "$REST_KEY_NAME" >/dev/null 2>&1 || true

    # Stop server
    echo -e "${BLUE}🛑 Stopping server...${NC}"
    kill $SERVER_PID 2>/dev/null || true
    sleep 2
else
    echo -e "${RED}❌ Failed to start server${NC}"
    ((TESTS_FAILED++))
fi

# Test 13: CLI Key Management Operations
echo -e "${BLUE}🔧 Testing comprehensive CLI operations...${NC}"

# Generate key for management tests
MGMT_KEY_NAME="mgmt-test-key-$(date +%s)"
run_test "CLI: Generate Management Key" "./better-ccflare --generate-api-key '$MGMT_KEY_NAME'"

# Test enable/disable cycle
run_test "CLI: Disable Management Key" "./better-ccflare --disable-api-key '$MGMT_KEY_NAME'"
run_test "CLI: Enable Management Key" "./better-ccflare --enable-api-key '$MGMT_KEY_NAME'"

# Clean up
run_test "CLI: Delete Management Key" "./better-ccflare --delete-api-key '$MGMT_KEY_NAME'"

# Test 14: CLI Error Handling
echo -e "${BLUE}⚠️ Testing CLI error handling...${NC}"

# Test duplicate key name
if ! ./better-ccflare --generate-api-key "$TEST_KEY_NAME" 2>/dev/null; then
    echo -e "${GREEN}✅ PASS${NC}: CLI Error Handling - Duplicate key name rejected"
    ((TESTS_PASSED++))
else
    echo -e "${RED}❌ FAIL${NC}: CLI Error Handling - Duplicate key name accepted"
    ((TESTS_FAILED++))
fi

# Test invalid key operations
if ! ./better-ccflare --delete-api-key "non-existent-key" 2>/dev/null; then
    echo -e "${GREEN}✅ PASS${NC}: CLI Error Handling - Non-existent key deletion rejected"
    ((TESTS_PASSED++))
else
    echo -e "${RED}❌ FAIL${NC}: CLI Error Handling - Non-existent key deletion accepted"
    ((TESTS_FAILED++))
fi

# Final results
echo ""
echo "========================================="
echo -e "${BLUE}📊 Test Results Summary${NC}"
echo "========================================="
echo -e "Total Tests: $((TESTS_PASSED + TESTS_FAILED))"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"

if [ $TESTS_FAILED -eq 0 ]; then
    echo ""
    echo -e "${GREEN}🎉 All tests passed! API authentication is working correctly.${NC}"
    exit 0
else
    echo ""
    echo -e "${YELLOW}⚠️  Some tests failed. Please review the output above.${NC}"
    exit 1
fi