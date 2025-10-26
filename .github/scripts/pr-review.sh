#!/bin/bash
set -euo pipefail

# Configuration
API_URL="https://openrouter.ai/api/v1/chat/completions"
# AI_MODELS should be set in workflow YAML as comma-separated list: "model1,model2,model3"
MODELS="${AI_MODELS}"
TEMPERATURE="${AI_TEMPERATURE}"
MAX_TOKENS="${AI_MAX_TOKENS}"
MAX_DIFF_SIZE="${MAX_DIFF_SIZE}"

# Validate required environment variables
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
    echo "Error: OPENROUTER_API_KEY is not set"
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
- Multiple AI providers: Claude OAuth, OpenRouter, Anthropic API
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
        -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
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
    if ! echo "${API_RESPONSE}" | jq empty > /dev/null 2>&1; then
        LAST_ERROR="Invalid JSON response from API: $(echo "${API_RESPONSE}" | head -c 200)..."
        echo "Error from model ${MODEL}: ${LAST_ERROR}"

        # If this is not the last model, try the next one
        if [[ "${MODEL}" != "${MODEL_ARRAY[-1]}" ]]; then
            echo "Trying next fallback model..."
            continue
        fi
    else
        # Check for API errors (now that we know it's valid JSON)
        if echo "${API_RESPONSE}" | jq -e '.error' > /dev/null 2>&1; then
            LAST_ERROR=$(echo "${API_RESPONSE}" | jq -r '.error.message // .error')
            echo "Error from model ${MODEL}: ${LAST_ERROR}"

            # If this is not the last model, try the next one
            if [[ "${MODEL}" != "${MODEL_ARRAY[-1]}" ]]; then
                echo "Trying next fallback model..."
                continue
            fi
        else
            # Try to extract review content with better error handling
            echo "Attempting to extract content from API response..."

            # Save API response to temp file for debugging
            response_file=$(mktemp)
            echo "${API_RESPONSE}" > "${response_file}"

            # Check if the response file starts with JSON (not HTML or other content)
            # Remove leading whitespace and check first character
            if sed 's/^[[:space:]]*//' "${response_file}" | head -c 1 | grep -q '{'; then
                # Try to extract content with error handling
                # Use sed to strip leading whitespace before jq
                if REVIEW_CONTENT=$(sed 's/^[[:space:]]*//' "${response_file}" | jq -r '.choices[0].message.content // empty' 2>/dev/null); then
                    echo "Successfully extracted content from model: ${MODEL}"
                    rm -f "${response_file}"

                    if [[ -n "$REVIEW_CONTENT" ]]; then
                        USED_MODEL="${MODEL}"
                        echo "Review received successfully from model: ${USED_MODEL}"
                        break
                    else
                        echo "Warning: Empty content received from model ${MODEL}"
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
