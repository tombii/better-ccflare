# Issue Triage Agent

This repository uses an automated issue triage agent that analyzes new issues and provides intelligent labeling, severity assessment, and initial responses.

## How It Works

When a new issue is opened, the GitHub Actions workflow automatically:

1. **Gathers Context**: Collects repository information and the issue details
2. **AI Analysis**: Sends the issue to Claude (via OpenRouter) for intelligent analysis
3. **Applies Labels**: Automatically tags the issue with relevant labels
4. **Assesses Severity**: Determines priority level (critical, high, medium, low)
5. **Provides Response**: Posts a helpful comment with analysis and guidance

## Available Labels

The triage agent can apply the following labels:

**Type Labels:**
- `bug` - Something isn't working
- `enhancement` - New feature or improvement request
- `documentation` - Documentation improvements
- `question` - User question or clarification needed
- `help-wanted` - Extra attention needed

**Priority Labels:**
- `priority-high` - Critical or high-severity issues
- `priority-medium` - Medium-severity issues
- `priority-low` - Low-severity issues

**Component Labels:**
- `backend` - Server/proxy related
- `frontend` - Dashboard/UI related
- `docker` - Docker deployment issues
- `auth` - Authentication/OAuth related
- `api` - API-related issues
- `good-first-issue` - Good for newcomers

## Setup

### Prerequisites

1. **OpenRouter API Key**: Get your API key from [OpenRouter](https://openrouter.ai/)
   - Sign up for an account (free)
   - Navigate to API Keys section
   - Create a new API key
   - Note: The triage agent uses a **free model** (`z-ai/glm-4.5-air:free`) by default, so no credits required!

### GitHub Repository Configuration

1. **Add OpenRouter API Key as Secret**:
   - Go to your repository Settings
   - Navigate to Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `OPENROUTER_API_KEY`
   - Value: Your OpenRouter API key
   - Click "Add secret"

2. **Verify Workflow Permissions**:
   - Go to Settings → Actions → General
   - Under "Workflow permissions", ensure:
     - "Read and write permissions" is selected
     - "Allow GitHub Actions to create and approve pull requests" is checked (optional)

### Customization

You can customize the triage agent by modifying the workflow file (`.github/workflows/issue-triage.yml`):

```yaml
env:
  AI_MODEL: "z-ai/glm-4.5-air:free"       # Change model here
  AI_TEMPERATURE: "0.3"                    # Adjust creativity (0.0-1.0)
  AI_MAX_TOKENS: "4000"                    # Response length limit (model supports 131K context)
```

**Available Models** (via OpenRouter):
- `z-ai/glm-4.5-air:free` (default, **completely free**, good quality)
- `anthropic/claude-3.5-sonnet` (best quality, paid)
- `anthropic/claude-3-haiku` (faster, paid)
- `meta-llama/llama-3.2-3b-instruct:free` (free alternative)
- `google/gemini-flash-1.5:free` (free alternative)
- See [OpenRouter models](https://openrouter.ai/models) for full list

### Customizing Labels

To modify available labels, edit the prompt in `.github/scripts/issue-triage.sh`:

```bash
# Find this line and modify the label list:
1. Suggested labels (choose from: bug, enhancement, documentation, ...)
```

Then ensure those labels exist in your repository:
- Go to Issues → Labels
- Create any new labels you added

## Cost Estimation

The default configuration uses the **free** `z-ai/glm-4.5-air:free` model, which means:

**Cost: $0** (completely free, unlimited usage)

If you switch to paid models like Claude:
- **Small issue** (< 500 chars): ~$0.001 - $0.005 per triage
- **Medium issue** (500-2000 chars): ~$0.005 - $0.01 per triage
- **Large issue** (2000+ chars): ~$0.01 - $0.03 per triage
- Typical monthly cost: **$1-5/month**

## Testing

To test the triage agent:

1. Create a test issue in your repository
2. Watch the Actions tab for the workflow run
3. Check the issue for:
   - Applied labels
   - Triage comment with analysis and response

### Manual Testing

You can test the script locally:

```bash
export OPENROUTER_API_KEY="your-key-here"
export GITHUB_TOKEN="your-github-token"
export ISSUE_NUMBER="1"
export ISSUE_TITLE="Test Issue"
export ISSUE_BODY="This is a test"
export ISSUE_AUTHOR="testuser"
export REPO_NAME="your-username/your-repo"

bash .github/scripts/issue-triage.sh
```

## Troubleshooting

### Workflow Not Running

- Check that the workflow file is in `.github/workflows/`
- Verify Actions are enabled: Settings → Actions → General
- Ensure issue was created, not edited (workflow triggers on `opened` event)

### API Errors

- **"OPENROUTER_API_KEY is not set"**: Add the secret to repository settings
- **"Unauthorized"**: Check that your API key is valid and has credits
- **"Model not found"**: Verify the model name in the workflow environment variables

### Labels Not Applied

- Ensure repository has write permissions for Actions
- Check that labels exist in the repository (create them if needed)
- Review workflow logs in the Actions tab for errors

### Script Errors

View detailed logs:
- Go to Actions tab
- Click on the failed workflow run
- Expand the "Triage issue" step to see full output

## Disabling the Triage Agent

To temporarily disable:
1. Go to `.github/workflows/issue-triage.yml`
2. Add at the top:

```yaml
on: []  # Disables all triggers
```

Or delete the workflow file entirely.

## Privacy & Security

- Issue content is sent to OpenRouter/Claude for analysis
- No sensitive data should be in issue titles/descriptions
- API keys are stored securely as GitHub secrets
- The agent only has read access to repository and write access to issues

## Contributing

To improve the triage agent:
1. Modify the prompt in `.github/scripts/issue-triage.sh`
2. Adjust labels and severity levels
3. Test with sample issues
4. Submit a pull request with your improvements

## Example Output

When an issue is created, the agent posts a comment like:

```markdown
## 🤖 Issue Triage

**Severity:** `medium`

**Analysis:**
This appears to be a bug report related to OAuth authentication with Claude.
The user is experiencing rate limiting issues when using multiple accounts.

---

Thank you for reporting this issue! This appears to be related to the account
rotation logic in the proxy. Please provide:
1. Your better-ccflare version
2. Number of accounts configured
3. Any error messages from the logs

The team will investigate and respond soon.

---
*This automated triage was performed by the better-ccflare Issue Triage Agent using Claude via OpenRouter.*
```

## Support

If you encounter issues with the triage agent:
1. Check the troubleshooting section above
2. Review workflow logs in the Actions tab
3. Open an issue (yes, it will triage itself! 🤖)
