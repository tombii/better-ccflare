#!/bin/bash
set -euo pipefail

# Configuration
API_URL="${LLM_URL}"
# AI_MODELS should be set in workflow YAML as comma-separated list: "model1,model2,model3"
MODELS="${AI_MODELS}"
TEMPERATURE="${AI_TEMPERATURE}"
MAX_TOKENS="${AI_MAX_TOKENS}"
MAX_DIFF_SIZE="${MAX_DIFF_SIZE}"

# Input validation and sanitization
MAX_TITLE_LENGTH=200
MAX_BODY_LENGTH=10000
MAX_AUTHOR_LENGTH=50
MAX_BRANCH_LENGTH=100

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

# Function to validate branch reference format
validate_branch_ref() {
    local ref="$1"
    local ref_name="$2"
    
    # Only allow alphanumeric, hyphens, underscores, slashes, and dots
    if [[ ! "$ref" =~ ^[a-zA-Z0-9._/-]+$ ]]; then
        echo "Error: $ref_name contains invalid characters: $ref"
        exit 1
    fi
    
    # Check length
    if [[ ${#ref} -gt $MAX_BRANCH_LENGTH ]]; then
        echo "Error: $ref_name is too long (max $MAX_BRANCH_LENGTH characters)"
        exit 1
    fi
    
    # Check for common attack patterns
    if echo "$ref" | grep -qE '\.\./|\.\.\\|~'; then
        echo "Error: $ref_name contains suspicious patterns"
        exit 1
    fi
}

# Function to validate and sanitize environment variables
validate_and_sanitize_env() {
    local var_name="$1"
    local var_value="${!var_name}"
    local max_length="${2:-1000}"
    local allow_special_chars="${3:-false}"
    
    # Check if required variable is set
    if [[ -z "$var_value" ]]; then
        echo "Error: $var_name is required but not set"
        exit 1
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
    echo "Error: LLM_API_KEY is not set"
    exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "Error: GITHUB_TOKEN is not set"
    exit 1
fi

if [[ -z "${AI_MODELS:-}" ]]; then
    echo "Error: AI_MODELS is not set"
    exit 1
fi

if [[ -z "${AI_TEMPERATURE:-}" ]]; then
    echo "Error: AI_TEMPERATURE is not set"
    exit 1
fi

if [[ -z "${AI_MAX_TOKENS:-}" ]]; then
    echo "Error: AI_MAX_TOKENS is not set"
    exit 1
fi

if [[ -z "${MAX_DIFF_SIZE:-}" ]]; then
    echo "Error: MAX_DIFF_SIZE is not set"
    exit 1
fi

# Validate and sanitize untrusted input variables
validate_and_sanitize_env "PR_TITLE" $MAX_TITLE_LENGTH
validate_and_sanitize_env "PR_AUTHOR" $MAX_AUTHOR_LENGTH
validate_and_sanitize_env "PR_DESCRIPTION" $MAX_BODY_LENGTH
validate_and_sanitize_env "BASE_BRANCH" $MAX_BRANCH_LENGTH
validate_and_sanitize_env "HEAD_BRANCH" $MAX_BRANCH_LENGTH

# Validate branch references
validate_branch_ref "${BASE_BRANCH}" "BASE_BRANCH"
validate_branch_ref "${HEAD_BRANCH}" "HEAD_BRANCH"

# Read diff from stdin
echo "Reading diff from stdin..."
DIFF=$(cat)

# Validate diff is not empty
if [[ -z "$DIFF" ]]; then
    echo "Error: No diff content provided"
    exit 1
fi

# Check diff size
DIFF_SIZE=$(echo "$DIFF" | wc -c)
echo "Diff size: $DIFF_SIZE bytes"

if [[ "$DIFF_SIZE" -gt "$MAX_DIFF_SIZE" ]]; then
    echo "Error: Diff size ($DIFF_SIZE bytes) exceeds maximum allowed size ($MAX_DIFF_SIZE bytes)"
    exit 1
fi

# Get repository context
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
EOF
)

# Build the PR context
PR_CONTEXT=$(cat <<EOF
Pull Request Details:
Title: ${PR_TITLE}
Author: ${PR_AUTHOR}
Base Branch: ${BASE_BRANCH}
Head Branch: ${HEAD_BRANCH}

Description:
${PR_DESCRIPTION}
EOF
)

# Create the review prompt
REVIEW_PROMPT="You are an expert code reviewer for the better-ccflare project, a load balancer proxy for Claude AI built with TypeScript/Bun.

Your task is to review the following pull request diff and provide:
1. **Security Issues**: Check for hardcoded secrets, API key exposure, SQL injection, XSS vulnerabilities, authentication bypasses, input validation problems
2. **Code Quality**: Assess code structure, maintainability, adherence to TypeScript best practices, proper error handling
3. **Performance**: Identify potential bottlenecks, inefficient algorithms, memory leaks, unnecessary computations
4. **Logic Issues**: Find bugs, edge cases, race conditions, incorrect implementations
5. **Best Practices**: Check for proper logging, appropriate abstractions, consistent patterns with existing codebase
6. **Suggestions**: Provide actionable improvements and recommendations

Repository Context:
${REPO_CONTEXT}

${PR_CONTEXT}

Review the following diff and provide constructive feedback in markdown format. Be thorough but concise. Use the following structure:

## Summary
Brief overview of the changes and overall assessment.

## 🔒 Security
List any security concerns or confirm if none found.

## 💡 Code Quality
Comment on code structure, maintainability, and best practices.

## ⚡ Performance
Note any performance concerns or optimizations.

## 🐛 Potential Issues
Highlight bugs, logic errors, or edge cases.

## ✅ Positive Aspects
Mention good practices and well-implemented features.

## 📝 Recommendations
Provide specific, actionable suggestions for improvement.

Diff to review:
\`\`\`diff
${DIFF}
\`\`\`

Remember: Be constructive, specific, and helpful. Focus on important issues rather than nitpicking style."

echo "Sending diff to OpenRouter for review..."

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

    # Use base64 encoding for the prompt to avoid JSON escaping issues
    local encoded_prompt=$(echo "${REVIEW_PROMPT}" | base64 -w 0)

    cat > "${temp_json_file}" <<EOF
{
    "model": "${model}",
    "temperature": ${TEMPERATURE},
    "max_tokens": ${MAX_TOKENS},
    "messages": [
        {
            "role": "system",
            "content": "You are an expert code reviewer specializing in TypeScript, Node.js/Bun, and web security. Provide thorough, constructive code reviews."
        },
        {
            "role": "user",
            "content": "$(echo "${REVIEW_PROMPT}" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')"
        }
    ]
}
EOF

    local api_response
    api_response=$(curl -s -X POST "${API_URL}" \
        -H "Authorization: Bearer ${LLM_API_KEY}" \
        -H "Content-Type: application/json" \
        -H "HTTP-Referer: https://github.com/${REPO_NAME}" \
        -H "X-Title: better-ccflare PR Review" \
        -d @"${temp_json_file}")

    # Clean up temp file
    rm -f "${temp_json_file}"

    echo "${api_response}"
}

# Try each model in sequence until one succeeds
REVIEW_CONTENT=""
USED_MODEL=""
LAST_ERROR=""

for MODEL in "${MODEL_ARRAY[@]}"; do
    # Trim whitespace from model name
    MODEL=$(echo "$MODEL" | xargs)

    API_RESPONSE=$(call_openrouter_api "${MODEL}" 2>/dev/null)

    # Check if response is valid JSON first
    # The API response has leading whitespace, so try to extract content directly
    # Save API response to temp file for processing
    response_file=$(mktemp)
    echo "${API_RESPONSE}" > "${response_file}"

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
                rm -f "${response_file}"
                continue
            fi
        else
            # Try to extract review content
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
                # Extract review content using Python
                if REVIEW_CONTENT=$(python3 -c "
import sys
content = sys.stdin.read()
# Remove leading whitespace until we hit {
while content and content[0] in ' \t\n\r':
    content = content[1:]
print(content, end='')
" <<< "${API_RESPONSE}" | jq -r '.choices[0].message.content // empty' 2>/dev/null); then
                    rm -f "${response_file}"

                    if [[ -n "$REVIEW_CONTENT" ]]; then
                        USED_MODEL="${MODEL}"
                        echo "Review received successfully from model: ${USED_MODEL}"
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
if [[ -z "$REVIEW_CONTENT" ]]; then
    echo "Error: All models failed. Last error: ${LAST_ERROR}"
    echo "Full last API response:"
    echo "${API_RESPONSE}"
    exit 1
fi

# Format the final comment
COMMENT_BODY=$(cat <<EOF
## 🤖 AI Code Review

${REVIEW_CONTENT}

---

**Stats:**
- Diff size: ${DIFF_SIZE} bytes
- Model: \`${USED_MODEL}\`
- Review generated at: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

---

⚠️ **Note**: This is an automated review. Please verify all suggestions and use your judgment before implementing changes.

*Generated by better-ccflare PR Review Agent using OpenRouter*
EOF
)

# Post the review comment
echo "Posting review comment to PR..."
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
    "https://api.github.com/repos/${REPO_NAME}/issues/${PR_NUMBER}/comments" \
    -d @"${temp_comment_file}" > /dev/null

# Clean up temp file
rm -f "${temp_comment_file}"

echo "PR review completed successfully!"
