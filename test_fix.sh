#!/bin/bash
# Test the fix for reading stdin only once
echo "Testing the stdin reading fix..."

# Simulate reading diff from stdin once
DIFF=$(cat)
echo "First, we read the diff from stdin and stored it in a variable"
echo "Original diff size: ${#DIFF} characters"

# Now sanitize the already-read content (not reading from stdin again)
DIFF=$(echo "$DIFF" | python3 -c "
import sys
content = sys.stdin.read()
# Remove control characters except \t, \n, \r
sanitized = ''.join(c for c in content if ord(c) >= 32 or c in '\t\n\r')
print(sanitized, end='')
")

echo "After sanitization: ${#DIFF} characters"
echo "Content:"
echo "$DIFF"
echo "Test completed successfully - no stdin reading conflict"