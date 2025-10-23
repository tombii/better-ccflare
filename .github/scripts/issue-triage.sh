#!/bin/bash
set -euo pipefail

# Configuration
API_URL="https://openrouter.ai/api/v1/chat/completions"
MODEL="${AI_MODEL:-z-ai/glm-4.5-air:free}"
TEMPERATURE="${AI_TEMPERATURE:-0.3}"
MAX_TOKENS="${AI_MAX_TOKENS:-4000}"

# Validate required environment variables
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
    echo "Error: OPENROUTER_API_KEY is not set"
    exit 1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "Error: GITHUB_TOKEN is not set"
    exit 1
fi

# Read repository structure for context
echo "Gathering repository context..."
REPO_CONTEXT=$(cat <<EOF
Repository: ${REPO_NAME}

Key components:
- Load balancer proxy for Claude AI with OAuth account pooling
- Monorepo structure with apps (TUI, server, lander) and packages (proxy, dashboard-web, etc.)
- Supports multiple AI providers: Claude (OAuth), OpenRouter, Anthropic API
- TypeScript/Bun-based project
- Includes Docker deployment and multi-architecture binaries

Main directories:
$(ls -d */ 2>/dev/null | head -10 || echo "Unable to list directories")
EOF
)

# Prepare the issue content
ISSUE_CONTENT=$(cat <<EOF
Repository Context:
${REPO_CONTEXT}

Issue Details:
Title: ${ISSUE_TITLE}
Author: ${ISSUE_AUTHOR}
Body:
${ISSUE_BODY}
EOF
)

# Create the triage prompt
TRIAGE_PROMPT="You are an expert GitHub issue triaging agent for the better-ccflare project, a load balancer proxy for Claude AI.

Your task is to analyze the following issue and provide:
1. Suggested labels (choose from: bug, enhancement, documentation, question, help-wanted, good-first-issue, priority-high, priority-medium, priority-low, backend, frontend, docker, auth, api)
2. Severity assessment (critical, high, medium, low)
3. Brief analysis of the issue
4. Initial response or guidance for the issue author

Respond in the following JSON format:
{
  \"labels\": [\"label1\", \"label2\"],
  \"severity\": \"medium\",
  \"analysis\": \"Brief analysis here\",
  \"response\": \"Helpful response to the issue author\"
}

Issue to triage:
${ISSUE_CONTENT}"

echo "Sending issue to OpenRouter for triage..."

# Call OpenRouter API
API_RESPONSE=$(curl -s -X POST "${API_URL}" \
    -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "HTTP-Referer: https://github.com/${REPO_NAME}" \
    -H "X-Title: better-ccflare Issue Triage" \
    -d "$(jq -n \
        --arg model "${MODEL}" \
        --argjson temperature "${TEMPERATURE}" \
        --argjson max_tokens "${MAX_TOKENS}" \
        --arg prompt "${TRIAGE_PROMPT}" \
        '{
            model: $model,
            temperature: $temperature,
            max_tokens: $max_tokens,
            messages: [
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

# Extract the triage result
TRIAGE_RESULT=$(echo "${API_RESPONSE}" | jq -r '.choices[0].message.content')

echo "Triage result received:"
echo "${TRIAGE_RESULT}"

# Parse the JSON response
LABELS=$(echo "${TRIAGE_RESULT}" | jq -r '.labels // [] | .[]' | tr '\n' ',')
SEVERITY=$(echo "${TRIAGE_RESULT}" | jq -r '.severity // "medium"')
ANALYSIS=$(echo "${TRIAGE_RESULT}" | jq -r '.analysis // "No analysis provided"')
RESPONSE=$(echo "${TRIAGE_RESULT}" | jq -r '.response // "Thank you for opening this issue!"')

# Add severity as a label
if [[ ! "${LABELS}" =~ "priority-" ]]; then
    case "${SEVERITY}" in
        critical|high)
            LABELS="${LABELS},priority-high"
            ;;
        medium)
            LABELS="${LABELS},priority-medium"
            ;;
        low)
            LABELS="${LABELS},priority-low"
            ;;
    esac
fi

# Remove trailing comma
LABELS=$(echo "${LABELS}" | sed 's/,$//')

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

# Post the triage comment
COMMENT_BODY=$(cat <<EOF
## 🤖 Issue Triage

**Severity:** \`${SEVERITY}\`

**Analysis:**
${ANALYSIS}

---

${RESPONSE}

---
*This automated triage was performed by the better-ccflare Issue Triage Agent using Claude via OpenRouter.*
EOF
)

echo "Posting triage comment..."
curl -s -X POST \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${REPO_NAME}/issues/${ISSUE_NUMBER}/comments" \
    -d "$(jq -n --arg body "${COMMENT_BODY}" '{body: $body}')"

echo "Issue triage completed successfully!"
