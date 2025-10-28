#!/bin/bash
set -euo pipefail

# Test the JSON parsing logic of the triage script with sample data
echo "Testing JSON parsing logic from issue-triage.sh script..."

# Sample triage result that would come from the AI API
TRIAGE_RESULT='```json
{
  "labels": ["bug", "backend", "priority-medium"],
  "severity": "medium",
  "analysis": "The issue indicates that the main better-ccflare command doesn'\''t load environment variables from .env files, while the server command does. This suggests a difference in environment configuration handling between different entry points. This could affect SSL settings and other critical configurations.",
  "response": "Thanks for reporting this issue! It sounds like there'\''s a discrepancy in how environment variables are being loaded between different entry points. To help diagnose this, could you:\\n\\n1. Check your `package.json` scripts section to see how `better-ccflare` and `server` commands are configured differently\\n2. Verify if the main `better-ccflare` entry point is explicitly loading environment variables\\n3. Check if there are different `.env` files being used (e.g., `.env.local`, `.env.production`)\\n\\nThis will help us identify whether it'\''s a configuration issue in the build setup or a missing environment loader in the main application entry point."
}
```'

echo "Sample triage result:"
echo "${TRIAGE_RESULT}"
echo ""

# Create a Python script file to handle the parsing
cat > /tmp/parse_json.py << 'EOF'
import sys, json, re

content = sys.argv[1]

# Try to extract JSON from markdown code blocks
json_match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', content, re.DOTALL)
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
EOF

# Parse the JSON response from the AI content
JSON_CONTENT=$(python3 /tmp/parse_json.py "${TRIAGE_RESULT}")

echo "Parsed JSON content:"
echo "${JSON_CONTENT}"
echo ""

# Parse the extracted JSON safely
LABELS=$(echo "${JSON_CONTENT}" | jq -r '.labels // [] | .[]' | tr '\n' ',' | sed 's/,$//')
SEVERITY=$(echo "${JSON_CONTENT}" | jq -r '.severity // "medium"')
ANALYSIS=$(echo "${JSON_CONTENT}" | jq -r '.analysis // "No analysis provided"')
RESPONSE=$(echo "${JSON_CONTENT}" | jq -r '.response // "Thank you for opening this issue!"')

echo "Extracted labels: ${LABELS}"
echo "Severity: ${SEVERITY}"
echo "Analysis preview: $(echo "${ANALYSIS}" | head -c 100)..."
echo "Response preview: $(echo "${RESPONSE}" | head -c 100)..."
echo ""

# Test the label inference fallback logic
if [[ -z "${LABELS}" ]]; then
    echo "Testing fallback label inference..."
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

echo "Final labels after inference: ${LABELS}"
echo ""
echo "Testing completed successfully!"

# Clean up
rm -f /tmp/parse_json.py
