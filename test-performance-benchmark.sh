#!/bin/bash

# Performance Benchmark Script for API Authentication
# Tests authentication overhead and performance impact

set -e

echo "🚀 better-ccflare API Authentication Performance Benchmark"
echo "=================================================="

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration
SERVER_URL="http://localhost:8082"
TEST_ITERATIONS=100
WARMUP_ITERATIONS=10
CONCURRENT_REQUESTS=10

# Test results storage
declare -A RESULTS

# Function to run performance test
run_performance_test() {
    local test_name="$1"
    local test_command="$2"
    local iterations="${3:-$TEST_ITERATIONS}"
    local description="$4"

    echo -e "${CYAN}📊 $test_name${NC}"
    echo -e "    $description"
    echo -e "    Iterations: $iterations"

    # Warm up
    echo -e "    ${BLUE}⚡ Warming up...${NC}"
    for i in $(seq 1 $WARMUP_ITERATIONS); do
        eval "$test_command" >/dev/null 2>&1
    done

    # Run benchmark
    echo -e "    ${BLUE}🏃 Running benchmark...${NC}"
    local start_time=$(date +%s%N)

    for i in $(seq 1 $iterations); do
        eval "$test_command" >/dev/null 2>&1
    done

    local end_time=$(date +%s%N)
    local total_time=$((($end_time - $start_time) / 1000000))  # Convert to milliseconds
    local avg_time=$(($total_time / $iterations))
    local req_per_sec=$((($iterations * 1000) / $total_time))

    RESULTS["$test_name"]="$total_time,$avg_time,$req_per_sec"

    echo -e "    ${GREEN}✅ Completed${NC}"
    echo -e "    Total time: ${total_time}ms | Average: ${avg_time}ms | RPS: ${req_per_sec}"
    echo ""
}

# Function to run concurrent test
run_concurrent_test() {
    local test_name="$1"
    local test_command="$2"
    local concurrent="$3"
    local description="$4"

    echo -e "${CYAN}📊 $test_name (Concurrent: $concurrent)${NC}"
    echo -e "    $description"

    # Create temporary file for PIDs
    local pid_file="/tmp/concurrent_pids_$$.txt"

    # Start concurrent requests
    echo -e "    ${BLUE}🚀 Starting $concurrent concurrent requests...${NC}"
    local start_time=$(date +%s%N)

    for i in $(seq 1 $concurrent); do
        eval "$test_command" >/dev/null 2>&1 &
        echo $! >> "$pid_file"
    done

    # Wait for all to complete
    wait
    local end_time=$(date +%s%N)

    # Calculate metrics
    local total_time=$((($end_time - $start_time) / 1000000))
    local avg_time=$(($total_time / $concurrent))
    local req_per_sec=$((($concurrent * 1000) / $total_time))

    RESULTS["$test_name-concurrent"]="$total_time,$avg_time,$req_per_sec"

    # Clean up
    rm -f "$pid_file"

    echo -e "    ${GREEN}✅ Completed${NC}"
    echo -e "    Total time: ${total_time}ms | Average: ${avg_time}ms | RPS: ${req_per_sec}"
    echo ""
}

# Function to compare authentication overhead
compare_overhead() {
    local auth_test="$1"
    local no_auth_test="$2"

    echo -e "${YELLOW}📈 Authentication Overhead Analysis${NC}"

    local auth_data="${RESULTS[$auth_test]}"
    local no_auth_data="${RESULTS[$no_auth_test]}"

    if [ -n "$auth_data" ] && [ -n "$no_auth_data" ]; then
        local auth_rps=$(echo "$auth_data" | cut -d',' -f3)
        local no_auth_rps=$(echo "$no_auth_data" | cut -d',' -f3)

        local overhead_pct=$(($no_auth_rps * 100 / $auth_rps - 100))

        echo -e "    No Auth RPS: $no_auth_rps"
        echo -e "    With Auth RPS: $auth_rps"
        echo -e "    Overhead: ${overhead_pct}%"

        if [ $overhead_pct -lt 10 ]; then
            echo -e "    ${GREEN}✅ Excellent performance (< 10% overhead)${NC}"
        elif [ $overhead_pct -lt 25 ]; then
            echo -e "    ${YELLOW}⚠️  Acceptable performance (10-25% overhead)${NC}"
        else
            echo -e "    ${RED}❌ Performance impact (> 25% overhead)${NC}"
        fi
    fi
    echo ""
}

# Function to run memory usage test
run_memory_test() {
    local test_name="$1"
    local test_command="$2"
    local duration="$3"
    local description="$4"

    echo -e "${CYAN}💾 $test_name${NC}"
    echo -e "    $description"
    echo -e "    Duration: ${duration}s"

    # Get initial memory
    local initial_memory=$(ps -o rss= -p $(pgrep -f better-ccflare | head -1) 2>/dev/null || echo "0")

    # Run test for specified duration
    echo -e "    ${BLUE}🏃 Running memory test...${NC}"
    local end_time=$(($(date +%s) + $duration))
    local requests=0

    while [ $(date +%s) -lt $end_time ]; do
        eval "$test_command" >/dev/null 2>&1
        ((requests++))
    done

    # Get final memory
    local final_memory=$(ps -o rss= -p $(pgrep -f better-ccflare | head -1) 2>/dev/null || echo "0")
    local memory_diff=$((final_memory - initial_memory))
    local requests_per_sec=$(($requests / $duration))

    echo -e "    ${GREEN}✅ Completed${NC}"
    echo -e "    Requests: $requests | Duration: ${duration}s | RPS: $requests_per_sec"
    echo -e "    Memory change: ${memory_diff}KB"
    echo ""
}

# Main benchmark execution
main() {
    echo "Starting performance benchmarks..."
    echo "Server URL: $SERVER_URL"
    echo "Test Iterations: $TEST_ITERATIONS"
    echo ""

    # Check if server is running
    if ! curl -s "$SERVER_URL/health" >/dev/null 2>&1; then
        echo -e "${RED}❌ Server not running at $SERVER_URL${NC}"
        echo "Please start better-ccflare server before running benchmarks"
        exit 1
    fi

    echo -e "${GREEN}✅ Server is running${NC}"
    echo ""

    # Test 1: Base health endpoint (no auth required)
    run_performance_test "Health Check" \
        "curl -s '$SERVER_URL/health'" \
        $TEST_ITERATIONS \
        "Health endpoint performance (no auth required)"

    # Test 2: API endpoints without API keys
    echo -e "${YELLOW}🔓 Testing WITHOUT API keys...${NC}"

    # Clear any existing API keys
    ./better-ccflare --list-api-keys 2>/dev/null | grep -o '^[[:space:]]*-[[:space:]]*' | awk '{print $2}' | while read -r key; do
        ./better-ccflare --delete-api-key "$key" >/dev/null 2>&1 || true
    done

    run_performance_test "Stats API (No Auth)" \
        "curl -s '$SERVER_URL/api/stats'" \
        $TEST_ITERATIONS \
        "Stats endpoint performance without authentication"

    run_performance_test "Accounts API (No Auth)" \
        "curl -s '$SERVER_URL/api/accounts'" \
        $TEST_ITERATIONS \
        "Accounts endpoint performance without authentication"

    # Test 3: Generate API key for auth testing
    echo -e "${YELLOW}🔑 Setting up API keys for authentication testing...${NC}"
    BENCHMARK_KEY="benchmark-key-$(date +%s)"
    ./better-ccflare --generate-api-key "$BENCHMARK_KEY" >/dev/null 2>&1

    if ./better-ccflare --list-api-keys 2>/dev/null | grep -q "$BENCHMARK_KEY"; then
        echo -e "${GREEN}✅ API key created for testing${NC}"
    else
        echo -e "${RED}❌ Failed to create API key${NC}"
        exit 1
    fi
    echo ""

    # Test 4: API endpoints with API keys
    echo -e "${YELLOW}🔒 Testing WITH API keys...${NC}"

    run_performance_test "Stats API (With Auth)" \
        "curl -s '$SERVER_URL/api/stats' -H 'x-api-key: btr-test-key-123'" \
        $TEST_ITERATIONS \
        "Stats endpoint performance with authentication"

    run_performance_test "Accounts API (With Auth)" \
        "curl -s '$SERVER_URL/api/accounts' -H 'x-api-key: btr-test-key-123'" \
        $TEST_ITERATIONS \
        "Accounts endpoint performance with authentication"

    run_performance_test "API Keys List" \
        "curl -s '$SERVER_URL/api/api-keys' -H 'x-api-key: btr-test-key-123'" \
        $TEST_ITERATIONS \
        "API keys listing performance"

    run_performance_test "API Keys Stats" \
        "curl -s '$SERVER_URL/api/api-keys/stats' -H 'x-api-key: btr-test-key-123'" \
        $TEST_ITERATIONS \
        "API keys stats performance"

    # Test 5: Concurrent requests
    echo -e "${YELLOW}🚀 Testing concurrent request performance...${NC}"

    run_concurrent_test "Stats API (Concurrent)" \
        "curl -s '$SERVER_URL/api/stats' -H 'x-api-key: btr-test-key-123'" \
        $CONCURRENT_REQUESTS \
        "Concurrent stats requests with authentication"

    run_concurrent_test "Accounts API (Concurrent)" \
        "curl -s '$SERVER_URL/api/accounts' -H 'x-api-key: btr-test-key-123'" \
        $CONCURRENT_REQUESTS \
        "Concurrent accounts requests with authentication"

    # Test 6: Memory usage
    echo -e "${YELLOW}💾 Testing memory usage...${NC}"

    run_memory_test "Memory Under Load" \
        "curl -s '$SERVER_URL/api/stats' -H 'x-api-key: btr-test-key-123'" \
        30 \
        "Memory usage during sustained load"

    # Performance comparison
    echo -e "${YELLOW}📈 Performance Analysis${NC}"
    echo "========================================"

    compare_overhead "Stats API (With Auth)" "Stats API (No Auth)"
    compare_overhead "Accounts API (With Auth)" "Accounts API (No Auth)"

    # Cleanup
    echo -e "${YELLOW}🧹 Cleaning up...${NC}"
    ./better-ccflare --delete-api-key "$BENCHMARK_KEY" >/dev/null 2>&1

    # Summary
    echo ""
    echo "========================================="
    echo -e "${BLUE}📊 Performance Benchmark Complete${NC}"
    echo "========================================="
    echo -e "Tests run: $TEST_ITERATIONS iterations each"
    echo -e "Concurrent tests: $CONCURRENT_REQUESTS concurrent requests"
    echo ""
    echo -e "${CYAN}Detailed Results:${NC}"

    for key in "${!RESULTS[@]}"; do
        local data="${RESULTS[$key]}"
        local total_time=$(echo "$data" | cut -d',' -f1)
        local avg_time=$(echo "$data" | cut -d',' -f2)
        local rps=$(echo "$data" | cut -d',' -f3)
        echo -e "  $key: ${avg_time}ms avg, $rps RPS"
    done

    echo ""
    echo -e "${GREEN}✅ Performance benchmark completed successfully!${NC}"
}

# Check if we're being sourced or executed
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
    echo "Performance benchmark script loaded. Run with: $0"
else
    main "$@"
fi