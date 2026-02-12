#!/bin/bash
set -euo pipefail

# Configuration
API_URL="${LLM_URL}"
# AI_MODELS should be set in workflow YAML as comma-separated list: "model1,model2,model3"
MODELS="${AI_MODELS}"
TEMPERATURE="${AI_TEMPERATURE}"
MAX_TOKENS="${AI_MAX_TOKENS}"

# Input validation and sanitization
MAX_TITLE_LENGTH=200
MAX_BODY_LENGTH=10000
MAX_AUTHOR_LENGTH=50
MAX_NUMBER_LENGTH=10

# Function to sanitize potentially dangerous inputs
sanitize_input() {
    local input="$1"
    local input_name="$2"
    
    # Remove dangerous shell metacharacters
    input=$(echo "$input" | sed 's/[;&|`$(){}[\]\\!<>?*]//g')
    
    # Remove newlines and control characters
    input=$(echo "$input" | tr -d '\n\r' | sed 's/[[:cntrl:]]//g')
    
    # Remove potential SQL injection patterns (case-insensitive)
    input=$(echo "$input" | tr '[:upper:]' '[:lower:]' | sed 's/union\|select\|insert\|delete\|update\|drop\|create\|alter\|exec//g')
    
    # Remove potential XSS patterns (case-insensitive)
    input=$(echo "$input" | tr '[:upper:]' '[:lower:]' | sed 's/javascript:\|data:\|vbscript:\|onload=\|onerror=//g')
    
    echo "$input"
}

# Function to validate and sanitize environment variables
validate_and_sanitize_env() {
    local var_name="$1"
    local var_value="${!var_name}"
    local max_length="${2:-1000}"
    local allow_special_chars="${3:-false}"
    local required="${4:-false}"
    
    # Check if required variable is set
    if [[ "$required" == "true" ]] && [[ -z "$var_value" ]]; then
        echo "Error: $var_name is required but not set"
        exit 1
    fi
    
    # Skip validation if not required and not set
    if [[ "$required" != "true" ]] && [[ -z "$var_value" ]]; then
        return 0
    fi
    
    # Check for obvious injection patterns
    if [[ "$allow_special_chars" != "true" ]]; then
        if echo "$var_value" | grep -qE '[;&|`$(){}[\]\\!<>?*]'; then
            echo "Error: $var_name contains potentially dangerous characters"
            exit 1
        fi
    fi
    
    # Check length
    if [[ ${#var_value} -gt $max_length ]]; then
        echo "Error: $var_name exceeds maximum length of $max_length characters"
        exit 1
    fi
    
    # Sanitize the input
    sanitized_value=$(sanitize_input "$var_value" "$var_name")
    
    # Update the environment variable
    export "$var_name"="$sanitized_value"
}

# Validate required environment variables
if [[ -z "${LLM_API_KEY:-}" ]]; then
    echo "Warning: LLM_API_KEY is not set"
    #exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "Warning: GITHUB_TOKEN is not set"
    #exit 1
fi

# Set defaults if not provided, then validate and sanitize
if [[ -z "${AI_MODELS:-}" ]]; then
    echo "Warning: AI_MODELS is not set, using default models"
    export AI_MODELS="glm-4.7,qwen3-coder-plus,glm-4.5-air"
fi

if [[ -z "${AI_TEMPERATURE:-}" ]]; then
    echo "Warning: AI_TEMPERATURE is not set, using default value"
    export AI_TEMPERATURE=0.7
fi

if [[ -z "${AI_MAX_TOKENS:-}" ]]; then
    echo "Warning: AI_MAX_TOKENS is not set, using default value"
    export AI_MAX_TOKENS=1000
fi

if [[ -z "${ISSUE_NUMBER:-}" ]]; then
    echo "Warning: ISSUE_NUMBER is not set, using default"
    export ISSUE_NUMBER=1
fi

if [[ -z "${ISSUE_TITLE:-}" ]]; then
    echo "Warning: ISSUE_TITLE is not set, using default"
    export ISSUE_TITLE="Test Issue for Triage"
fi

if [[ -z "${ISSUE_AUTHOR:-}" ]]; then
    echo "Warning: ISSUE_AUTHOR is not set, using default"
    export ISSUE_AUTHOR="test-user"
fi

if [[ -z "${REPO_NAME:-}" ]]; then
    echo "Warning: REPO_NAME is not set, using current repo"
    export REPO_NAME="tomascassell/better-ccflare"
fi

if [[ -z "${ISSUE_BODY:-}" ]]; then
    echo "Warning: ISSUE_BODY is not set, using default"
    export ISSUE_BODY="This is a test issue to demonstrate the triage functionality."
fi

# Validate and sanitize untrusted input variables
validate_and_sanitize_env "ISSUE_TITLE" $MAX_TITLE_LENGTH
validate_and_sanitize_env "ISSUE_AUTHOR" $MAX_AUTHOR_LENGTH
validate_and_sanitize_env "ISSUE_BODY" $MAX_BODY_LENGTH
validate_and_sanitize_env "ISSUE_NUMBER" $MAX_NUMBER_LENGTH true
validate_and_sanitize_env "REPO_NAME" 100

# Read repository structure for context
echo "Gathering repository context..."
REPO_CONTEXT=$(cat <<EOF
Repository: ${REPO_NAME}
Project: better-ccflare - Load balancer proxy for Claude AI

Key technologies:
- TypeScript/Bun runtime
- Monorepo structure (apps: TUI, server, lander; packages: proxy, dashboard-web, etc.)
- SQLite database for account and request tracking
- Multiple AI providers: Claude CLI OAuth, OpenRouter, Anthropic API
- Hono web framework for server
- React for dashboard UI

Important patterns:
- Dependency injection via core-di
- Structured logging via logger package
- Database migrations in packages/database
- Token counting and streaming in proxy package

Main directories:
$(ls -d */ 2>/dev/null | head -10 || echo "Unable to list directories")
EOF
)

# Prepare the issue content - use printf for safer handling
ISSUE_CONTENT=$(printf '%s\n%s\n%s\n%s\n%s\n%s\n' \
    "Repository Context:" \
    "${REPO_CONTEXT}" \
    "" \
    "Issue Details:" \
    "Title: ${ISSUE_TITLE}" \
    "Author: ${ISSUE_AUTHOR}" \
    "Body:" \
    "${ISSUE_BODY:-No description provided}")

# Create the triage prompt - use printf for safe handling of special characters
TRIAGE_PROMPT=$(printf '%s\n\n%s\n\n%s\n\n%s\n' \
    "You are an expert GitHub issue triaging agent for the better-ccflare project, a load balancer proxy for Claude AI." \
    "Your task is to analyze the following issue and provide:" \
    "1. Suggested labels (choose from: bug, enhancement, documentation, question, help-wanted, good-first-issue, priority-high, priority-medium, priority-low, backend, frontend, docker, auth, api)" \
    "2. Severity assessment (critical, high, medium, low)" \
    "3. Brief analysis of the issue" \
    "4. Initial response or guidance for the issue author" \
    "" \
    "For bug reports, if the issue doesn't include the user's better-ccflare version and installation method, specifically request this information in your response:" \
    "- better-ccflare version (e.g., v2.1.0, or commit hash if built from source)" \
    "- Installation method (npm, bun, pre-compiled binary, built from source, Docker/Docker Compose)" \
    "- Operating system and architecture" \
    "" \
    "Respond in the following JSON format:" \
    '{"labels": ["label1", "label2"], "severity": "medium", "analysis": "Brief analysis here", "response": "Helpful response to the issue author"}' \
    "" \
    "Issue to triage:" \
    "${ISSUE_CONTENT}")

echo "Sending issue for triage..."

# Convert comma-separated models string to array
IFS=',' read -ra MODEL_ARRAY <<< "$MODELS"
echo "Configured models: ${MODELS}"
echo "Will try ${#MODEL_ARRAY[@]} model(s)"

# Function to call OpenRouter API with a specific model
call_openrouter_api() {
    local model=$1
    echo "Attempting with model: ${model}" >&2

    # Create a temporary JSON file for the request payload to avoid jq parsing issues
    local temp_json_file=$(mktemp)

    cat > "${temp_json_file}" <<EOF
{
    "model": "${model}",
    "temperature": ${TEMPERATURE},
    "max_tokens": ${MAX_TOKENS},
    "messages": [
        {
            "role": "system",
            "content": "You are an expert GitHub issue triaging agent specializing in load balancer proxies, TypeScript, and web security. Provide thorough, constructive issue analysis."
        },
        {
            "role": "user",
            "content": $(echo "${TRIAGE_PROMPT}" | jq -Rs .)
        }
    ]
}
EOF

    local api_response
    api_response=$(curl -s -X POST "${API_URL}" \
        -H "Authorization: Bearer ${LLM_API_KEY}" \
        -H "Content-Type: application/json" \
        -H "HTTP-Referer: https://github.com/${REPO_NAME}" \
        -H "X-Title: better-ccflare Issue Triage" \
        -d @"${temp_json_file}")

    # Clean up temp file
    rm -f "${temp_json_file}"

    echo "${api_response}"
}

# Try each model in sequence until one succeeds
TRIAGE_RESULT=""
USED_MODEL=""
LAST_ERROR=""

for MODEL in "${MODEL_ARRAY[@]}"; do
    # Trim whitespace from model name
    MODEL=$(echo "$MODEL" | xargs)

    API_RESPONSE=$(call_openrouter_api "${MODEL}" 2>/dev/null)

    # Check if response is valid JSON first
    # Use Python to safely strip leading whitespace while preserving JSON
    trimmed_response=$(python3 -c "
import sys
content = sys.stdin.read()
# Remove leading whitespace until we hit {
while content and content[0] in ' \t\n\r':
    content = content[1:]
print(content, end='')
" <<< "${API_RESPONSE}")

    if echo "${trimmed_response}" | head -c 1 | grep -q '{'; then
        # Valid JSON detected, check for API errors first
        if echo "${trimmed_response}" | jq -e '.error' > /dev/null 2>&1; then
            LAST_ERROR=$(echo "${trimmed_response}" | jq -r '.error.message // .error')
            echo "Error from model ${MODEL}: ${LAST_ERROR}"

            # If this is not the last model, try the next one
            if [[ "${MODEL}" != "${MODEL_ARRAY[-1]}" ]]; then
                echo "Trying next fallback model..."
                continue
            fi
        else
            # Try to extract triage result content
            response_file=$(mktemp)
            echo "${API_RESPONSE}" > "${response_file}"

            # Check if the response file starts with JSON (not HTML or other content)
            # Use Python to safely strip leading whitespace while preserving JSON
            trimmed_response=$(python3 -c "
import sys
content = sys.stdin.read()
# Remove leading whitespace until we hit {
while content and content[0] in ' \t\n\r':
    content = content[1:]
print(content, end='')
" <<< "${API_RESPONSE}")

            if echo "${trimmed_response}" | head -c 1 | grep -q '{'; then
                # Extract triage result using Python
                if TRIAGE_RESULT=$(python3 -c "
import sys, json
content = sys.stdin.read()
# Remove leading whitespace until we hit {
while content and content[0] in ' \t\n\r':
    content = content[1:]
try:
    data = json.loads(content)
    if 'choices' in data and len(data['choices']) > 0:
        print(data['choices'][0]['message']['content'])
except:
    pass
" <<< "${API_RESPONSE}" 2>/dev/null); then
                    rm -f "${response_file}"

                    if [[ -n "$TRIAGE_RESULT" ]]; then
                        USED_MODEL="${MODEL}"
                        echo "Triage result received successfully from model: ${USED_MODEL}"
                        echo "Triage result:"
                        echo "${TRIAGE_RESULT}"
                        break
                    else
                        LAST_ERROR="Empty content in API response"
                    fi
                else
                    echo "Error: Failed to parse JSON response from model ${MODEL}"
                    LAST_ERROR="JSON parsing error in content extraction"
                    # Show first 200 chars of response for debugging (stripping leading whitespace)
                    echo "Response preview: $(sed 's/^[[:space:]]*//' "${response_file}" | head -c 200)..."
                fi
            else
                echo "Error: Non-JSON response received from model ${MODEL}"
                LAST_ERROR="Non-JSON API response"
                # Show first 200 chars of response for debugging
                echo "Response preview: $(head -c 200 "${response_file}")..."
            fi

            # Clean up temp file
            rm -f "${response_file}"

            # If this is not the last model, try the next one
            if [[ "${MODEL}" != "${MODEL_ARRAY[-1]}" ]]; then
                echo "Trying next fallback model..."
                continue
            fi
        fi
    fi
done

# If we exhausted all models without success, exit with error
if [[ -z "$TRIAGE_RESULT" ]]; then
    echo "Error: All models failed. Last error: ${LAST_ERROR}"
    echo "Full last API response:"
    echo "${API_RESPONSE}"
    exit 1
fi

# Parse the JSON response from the AI content
# Extract JSON from AI response that might be wrapped in markdown or text
JSON_CONTENT=$(echo "${TRIAGE_RESULT}" | python3 -c "
import sys, json, re
content = sys.stdin.read()

# Try to extract JSON from markdown code blocks
json_match = re.search(r'\x60\x60\x60(?:json)?\s*(\{.*?\})\s*\x60\x60\x60', content, re.DOTALL)
if json_match:
    json_str = json_match.group(1)
else:
    # Try to find JSON object directly in the text
    json_match = re.search(r'(\{.*?\})', content, re.DOTALL)
    if json_match:
        json_str = json_match.group(1)
    else:
        # If no JSON found, assume the whole content is the response
        json_str = '{}'

try:
    data = json.loads(json_str)
    print(json.dumps(data))
except:
    # If parsing fails, return empty JSON object
    print('{}')
")

# Parse the extracted JSON safely
LABELS=$(echo "${JSON_CONTENT}" | jq -r '.labels // [] | .[]' | tr '\n' ',' | sed 's/,$//')
SEVERITY=$(echo "${JSON_CONTENT}" | jq -r '.severity // "medium"')
ANALYSIS=$(echo "${JSON_CONTENT}" | jq -r '.analysis // "No analysis provided"')
RESPONSE=$(echo "${JSON_CONTENT}" | jq -r '.response // "Thank you for opening this issue!"')

# If no labels were found, use the AI response to infer them
if [[ -z "${LABELS}" ]]; then
    # Simple label inference from the AI response
    LABELS=""
    if echo "${TRIAGE_RESULT}" | grep -i -E "(bug|error|crash|fail)" > /dev/null; then
        LABELS="bug"
    fi
    if echo "${TRIAGE_RESULT}" | grep -i -E "(feature|enhancement|add)" > /dev/null; then
        LABELS="${LABELS:+$LABELS,}enhancement"
    fi
    if echo "${TRIAGE_RESULT}" | grep -i -E "(doc|readme|guide)" > /dev/null; then
        LABELS="${LABELS:+$LABELS,}documentation"
    fi
    if echo "${TRIAGE_RESULT}" | grep -i -E "(question|help|how)" > /dev/null; then
        LABELS="${LABELS:+$LABELS,}question"
    fi
fi

# Add severity as a label
if [[ ! "${LABELS}" =~ "priority-" ]]; then
    case "${SEVERITY}" in
        critical|high)
            LABELS="${LABELS:+$LABELS,}priority-high"
            ;;
        medium)
            LABELS="${LABELS:+$LABELS,}priority-medium"
            ;;
        low)
            LABELS="${LABELS:+$LABELS,}priority-low"
            ;;
    esac
fi

# Remove trailing comma
LABELS=$(echo "${LABELS}" | sed 's/^,*//;s/,*$//')

# Apply labels to the issue
if [[ -n "${LABELS}" ]]; then
    echo "Applying labels: ${LABELS}"
    IFS=',' read -ra LABEL_ARRAY <<< "${LABELS}"
    LABELS_JSON=$(printf '%s\n' "${LABEL_ARRAY[@]}" | jq -R . | jq -s .)

    curl -s -X POST \
        -H "Authorization: token ${GITHUB_TOKEN}" \
        -H "Accept: application/vnd.github.v3+json" \
        "https://api.github.com/repos/${REPO_NAME}/issues/${ISSUE_NUMBER}/labels" \
        -d "{\"labels\": ${LABELS_JSON}}"
fi

# Post the triage comment - use printf for safer handling
COMMENT_BODY=$(printf '%s\n\n**Severity:** `%s`\n\n**Analysis:**\n%s\n\n---\n\n%s\n\n---\n*This automated triage was performed by the better-ccflare Issue Triage Agent using %s.*' \
    "## 🤖 Issue Triage" \
    "${SEVERITY}" \
    "${ANALYSIS}" \
    "${RESPONSE}" \
    "${USED_MODEL}")

echo "Posting triage comment..."
# Create a temporary JSON file for GitHub comment to avoid jq parsing issues
temp_comment_file=$(mktemp)

# Properly escape the comment body for JSON
cat > "${temp_comment_file}" <<EOF
{
    "body": $(echo "${COMMENT_BODY}" | jq -Rs .)
}
EOF

curl -s -X POST \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${REPO_NAME}/issues/${ISSUE_NUMBER}/comments" \
    -d @"${temp_comment_file}" > /dev/null

# Clean up temp file
rm -f "${temp_comment_file}"

echo "Issue triage completed successfully!"