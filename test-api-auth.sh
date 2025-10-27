#!/bin/bash

# Test script for API Authentication
# Usage: ./test-api-auth.sh

set -e

echo "🧪 better-ccflare API Authentication Test Suite"
echo "=========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Test configuration
API_BASE_URL="http://localhost:8081"  # Use different port to avoid conflicts
DASHBOARD_URL="http://localhost:8081"

# Function to print test result
print_result() {
    local test_name="$1"
    local test_status="$2"
    local message="$3"

    if [ "$test_status" = "PASS" ]; then
        echo -e "${GREEN}✅ PASS${NC}: $test_name"
    else
        echo -e "${RED}❌ FAIL${NC}: $test_name"
    fi
    echo -e "    $message"
}

# Function to check if server is ready
wait_for_server() {
    echo -e "${BLUE}⏳ Waiting for server to be ready...${NC}"

    for i in {1..30}; do
        if curl -s "$API_BASE_URL/health" > /dev/null 2>&1 | grep -q "ok"; then
            echo -e "${GREEN}✓ Server is ready!${NC}"
            return
        fi
        echo -n -e "${BLUE}⏳ Waiting for server... ($i/30)${NC}"
        sleep 1
    done

    echo -e "${RED}❌ Server failed to start within 30 seconds${NC}"
    exit 1
}

# Function to test API key generation
test_api_key_generation() {
    echo -e "${YELLOW}🔑 Testing API Key Generation${NC}"

    # Test 1: Generate API key via CLI
    echo -e "  ${BLUE}→ Generating API key via CLI...${NC}"

    # Generate a test key
    KEY_NAME="test-key-$(date +%s)"

    if output=$(./better-ccflare --generate-api-key "$KEY_NAME" 2>&1); then
        if echo "$output" | grep -q "✅ API Key Generated Successfully"; then
            KEY_ID=$(echo "$output" | grep "ID:" | head -1 | awk '{print $2}')
            FULL_KEY=$(echo "$output" | grep -Key:" | head -1 | awk '{print $2}')
            PREFIX=$(echo "$output" | grep "Prefix:" | head -1 | awk '{print $2}')

            print_result "CLI API Key Generation" "PASS" "Generated key: $KEY_NAME (ID: $KEY_ID, Prefix: $PREFIX)"

            # Test 2: Verify key appears in database via CLI
            echo -e "  ${BLUE}→ Listing API keys via CLI...${NC}"

            if ./better-ccflare --list-api-keys 2>&1 | grep -q "$KEY_NAME"; then
                print_result "API Key Database Storage" "PASS" "Generated key found in database"
            else
                print_result "API Key Database Storage" "FAIL" "Generated key not found in database"
            fi
        else
            print_result "CLI API Key Generation" "FAIL" "Failed to generate API key via CLI"
        fi
    else
        print_result "CLI API Key Generation" "FAIL" "CLI command not available"
    fi
}

# Function to test API key management
test_api_key_management() {
    echo -e "${YELLOW}🔧 Testing API Key Management${NC}"

    # Test 1: List API keys via REST API
    echo -e "  ${BLUE}→ Testing GET /api/api-keys...${NC}"

    if response=$(curl -s "$API_BASE_URL/api/api-keys" 2>&1); then
        if echo "$response" | grep -q '"success":true'; then
            print_result "List API Keys" "PASS" "API keys retrieved successfully"
        else
            print_result "List API Keys" "FAIL" "Failed to retrieve API keys"
        fi

    # Test 2: Get API key statistics via REST API
    echo -e "  ${BLUE}→ Testing GET /api/api-keys/stats...${NC}"

    if response=$(curl -s "$API_BASE_URL/api/api-keys/stats" 2>&1); then
        if echo "$response" | grep -q '"success":true'; then
            TOTAL_KEYS=$(echo "$response" | grep -o '"total": [0-9]*' | head -1 | cut -d'"' -f2)
            ACTIVE_KEYS=$(echo "$response" | grep -o '"active": [0-9]*' | head -1 | cut -d'"' -f2)

            print_result "API Key Statistics" "PASS" "Total: $TOTAL_KEYS, Active: $ACTIVE_KEYS"
        else
            print_result "API Key Statistics" "FAIL" "Failed to retrieve API key statistics"
        fi
}

# Function to test authentication requirements
test_authentication_requirements() {
    echo -e "${YELLOW}🔒 Testing Authentication Requirements${NC}"

    # Test 1: Check if no API keys = no auth required
    echo -e "  ${BLUE}→ Testing without API keys...${NC}"

    # Generate a key for this test
    TEST_KEY="test-auth-no-keys-$(date +%s)"
    if ./better-ccflare --generate-api-key "$TEST_KEY" >/dev/null 2>&1; then
        # Make a request without API key
        echo -e "  ${BLUE}→ Testing request without API key...${NC}"

        if response=$(curl -s "$API_BASE_URL/v1/messages" \
            -H "Content-Type: application/json" \
            -d '{"model": "claude-3-haiku-20240307", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}' 2>&1); then

            if echo "$response" | grep -q "error"; then
                print_result "No Authentication Required" "FAIL" "Request without API key failed"
            else
                print_result "No Authentication Required" "PASS" "Request without API key succeeded"
            fi

        # Clean up test key
        ./better-ccflare --delete-api-key "$TEST_KEY" >/dev/null 2>&1
    else
        print_result "No Authentication Required" "FAIL" "Could not create test API key"
        fi

    # Test 2: Check if API keys present = auth required
    echo -e "  ${BLUE}→ Testing with API keys present...${NC}"

    if [ "$ACTIVE_KEYS" -gt 0 ]; then
        # Make a request with API key
        echo -e "  ${BLUE}→ Testing request with API key...${NC}"

        if response=$(curl -s "$API_BASE_URL/v1/messages" \
            -H "Content-Type: application/json" \
            -H "x-api-key: btr-test1234567890abcdef" \
            -d '{"model": "claude-3-haiku-20240307", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}' 2>&1); then

            if echo "$response" | grep -q "error"; then
                print_result "Authentication Required" "FAIL" "Request with API key failed"
            else
                print_result "Authentication Required" "PASS" "Request with API key succeeded"
            fi
    else
        print_result "Authentication Required" "SKIP" "No API keys available to test"
    fi
}

# Function to test API key validation
test_api_key_validation() {
    echo -e "${YELLOW}🔍 Testing API Key Validation${NC}"

    # Test 1: Try invalid API key
    echo -e "  ${BLUE}→ Testing invalid API key...${NC}"

    if response=$(curl -s "$API_BASE_URL/v1/messages" \
            -H "Content-Type: application/json" \
            -H "x-api-key: invalid-key-123" \
            -d '{"model": "claude-3-haiku-20240307", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}' 2>&1); then

        if echo "$response" | grep -q '"error"'; then
            print_result "Invalid API Key" "PASS" "Invalid API key properly rejected"
        else
            print_result "Invalid API Key" "FAIL" "Invalid API key was accepted"
        fi

    # Test 2: Try valid but disabled API key
    echo -e "  ${BLUE}→ Testing disabled API key...${NC}"

    # Generate and disable a key for this test
    DISABLED_KEY="test-disabled-key-$(date +%s)"
    if ./better-ccflare --generate-api-key "$DISABLED_KEY" >/dev/null 2>&1 && \
       ./better-ccflare --disable-api-key "$DISABLED_KEY" >/dev/null 2>&1; then

        if response=$(curl -s "$API_BASE_URL/v1/messages" \
            -H "Content-Type: application/json" \
            -H "x-api-key: btr-disabled-test-123" \
            -d '{"model": "claude-3-haiku-20240307", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}' 2>&1); then

            if echo "$response" | grep -q '"error"'; then
                print_result "Disabled API Key" "PASS" "Disabled API key properly rejected"
            else
                print_result "Disabled API Key" "FAIL" "Disabled API key was accepted"
            fi

        # Clean up disabled key
        ./better-ccflare --delete-api-key "$DISABLED_KEY" >/dev/null 2>&1
    else
        print_result "Disabled API Key" "SKIP" "Could not create disabled test key"
    fi
}

# Function to test header formats
test_header_formats() {
    echo -e "${YELLOW}📋 Testing Header Formats${NC}"

    # Test x-api-key header
    echo -e "  ${BLUE}→ Testing x-api-key header...${NC}"

    if response=$(curl -s "$API_BASE_URL/v1/messages" \
            -H "Content-Type: application/json" \
            -H "x-api-key: btr-header-test-123" \
            -d '{"model": "claude-3-haiku-20240307", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}' 2>&1); then

        if echo "$response" | grep -q '"error"'; then
            print_result "x-api-key Header" "FAIL" "Request with x-api-key header failed"
        else
            print_result "x-api-key Header" "PASS" "Request with x-api-key header succeeded"
        fi

    # Test Authorization: Bearer header
    echo -e "  ${BLUE}→ Testing Authorization: Bearer header...${NC}"

    if response=$(curl -s "$API_BASE_URL/v1/messages" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer btr-bearer-test-123" \
            -d '{"model": "claude-3-haiku-20240307", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}' 2>&1); then

        if echo "$response" | grep -q '"error"'; then
            print_result "Authorization Bearer Header" "FAIL" "Request with Authorization: Bearer header failed"
        else
            print_result "Authorization Bearer Header" "PASS" "Request with Authorization: Bearer header succeeded"
        fi
}

# Function to test web dashboard
test_web_dashboard() {
    echo -e "${YELLOW}🌐 Testing Web Dashboard${NC}"

    # Test 1: Check if dashboard loads
    echo -e "  ${BLUE}→ Testing dashboard load...${NC}"

    if response=$(curl -s "$DASHBOARD_URL/" 2>&1 | grep -q "better-ccflare"; then
        print_result "Dashboard Load" "PASS" "Dashboard loads successfully"
    else
        print_result "Dashboard Load" "FAIL" "Dashboard failed to load"
    fi
}

# Main test execution
main() {
    echo "🚀 Starting API Authentication Test Suite"
    echo "Testing server at: $API_BASE_URL"
    echo ""

    # Wait for server to be ready
    wait_for_server

    # Run all tests
    test_api_key_generation
    test_api_key_management
    test_authentication_requirements
    test_api_key_validation
    test_header_formats
    test_web_dashboard

    echo ""
    echo -e "${GREEN}🏁 API Authentication Test Suite Complete!${NC}"
    echo ""

    # Generate test summary
    local total_tests=0
    local passed_tests=0
    local failed_tests=0

    # Count test results
    for result in "${!results[@]}"; do
        if [[ "$result" == "PASS:"* ]]; then
            ((passed_tests++))
        elif [[ "$result" == "FAIL:"* ]]; then
            ((failed_tests++))
        fi
        ((total_tests++))
    done

    echo -e "${BLUE}📊 Test Summary:${NC}"
    echo -e "  Total Tests: $total_tests"
    echo -e "  ${GREEN}Passed: $passed_tests${NC}"
    echo -e "  ${RED}Failed: $failed_tests${NC}"

    if [ $passed_tests -eq $total_tests ]; then
        echo -e "${GREEN}🎉 All tests passed!${NC}"
        exit 0
    else
        echo -e "${YELLOW}⚠️  Some tests failed. Check the results above.${NC}"
        exit 1
    fi
}

# Run tests if script is executed directly
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
    main
fi