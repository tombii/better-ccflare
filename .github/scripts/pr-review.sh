#!/bin/bash
set -euo pipefail

# Configuration
API_URL="https://openrouter.ai/api/v1/chat/completions"
MODEL="${AI_MODEL:-z-ai/glm-4.5-air:free}"
TEMPERATURE="${AI_TEMPERATURE:-0.2}"
MAX_TOKENS="${AI_MAX_TOKENS:-8000}"
MAX_DIFF_SIZE="${MAX_DIFF_SIZE:-600000}"

# Validate required environment variables
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
    echo "Error: OPENROUTER_API_KEY is not set"
    exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "Error: GITHUB_TOKEN is not set"
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

# Call OpenRouter API
API_RESPONSE=$(curl -s -X POST "${API_URL}" \
    -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "HTTP-Referer: https://github.com/${REPO_NAME}" \
    -H "X-Title: better-ccflare PR Review" \
    -d "$(jq -n \
        --arg model "${MODEL}" \
        --argjson temperature "${TEMPERATURE}" \
        --argjson max_tokens "${MAX_TOKENS}" \
        --arg prompt "${REVIEW_PROMPT}" \
        '{
            model: $model,
            temperature: $temperature,
            max_tokens: $max_tokens,
            messages: [
                {
                    role: "system",
                    content: "You are an expert code reviewer specializing in TypeScript, Node.js/Bun, and web security. Provide thorough, constructive code reviews."
                },
                {
                    role: "user",
                    content: $prompt
                }
            ]
        }')")

# Check for API errors
if echo "${API_RESPONSE}" | jq -e '.error' > /dev/null 2>&1; then
    echo "Error from OpenRouter API:"
    echo "${API_RESPONSE}" | jq -r '.error.message // .error'
    exit 1
fi

# Extract the review content
REVIEW_CONTENT=$(echo "${API_RESPONSE}" | jq -r '.choices[0].message.content // empty')

if [[ -z "$REVIEW_CONTENT" ]]; then
    echo "Error: No review content received from API"
    echo "Full API response:"
    echo "${API_RESPONSE}"
    exit 1
fi

echo "Review received successfully!"

# Format the final comment
COMMENT_BODY=$(cat <<EOF
## 🤖 AI Code Review

${REVIEW_CONTENT}

---

**Stats:**
- Diff size: ${DIFF_SIZE} bytes
- Model: \`${MODEL}\`
- Review generated at: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

---

⚠️ **Note**: This is an automated review. Please verify all suggestions and use your judgment before implementing changes.

*Generated by better-ccflare PR Review Agent using OpenRouter*
EOF
)

# Post the review comment
echo "Posting review comment to PR..."
curl -s -X POST \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${REPO_NAME}/issues/${PR_NUMBER}/comments" \
    -d "$(jq -n --arg body "${COMMENT_BODY}" '{body: $body}')" > /dev/null

echo "PR review completed successfully!"
