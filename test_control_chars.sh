#!/bin/bash

# Test script to verify the control character sanitization works

# Create a test diff with control characters
TEST_DIFF="This is a test diff
with some normal content
+ Added a new line
- Removed a line
But it also has some problematic control characters like $(printf '\001') and $(printf '\002')"

echo "Original test diff (with control chars):"
echo "$TEST_DIFF" | cat -A  # Show all characters including control chars

echo -e "\nSanitizing diff..."
SANITIZED_DIFF=$(python3 -c "
import sys
content = sys.stdin.read()
# Remove control characters except \t, \n, \r
sanitized = ''.join(c for c in content if ord(c) >= 32 or c in '\t\n\r')
print(sanitized, end='')
" <<< "$TEST_DIFF")

echo -e "\nSanitized diff (without control chars):"
echo "$SANITIZED_DIFF" | cat -A  # Show all characters to verify control chars are removed

echo -e "\nTesting JSON encoding..."
JSON_ENCODED=$(python3 -c "
import json
import sys
content = sys.stdin.read()
print(json.dumps(content))
" <<< "$SANITIZED_DIFF")

echo "JSON encoding successful: ${JSON_ENCODED:0:100}..."

echo -e "\nTest completed successfully!"