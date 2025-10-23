# PR Review Agent

This repository uses an automated code review agent that analyzes pull request diffs and provides intelligent, comprehensive code reviews using AI.

## How It Works

When you add the `ai_code_review` label to a pull request, the GitHub Actions workflow automatically:

1. **Fetches Changes**: Gets the diff between base and head branches
2. **Validates Size**: Ensures diff is under 800KB limit
3. **AI Analysis**: Sends the diff to an AI model (via OpenRouter) for comprehensive review
4. **Posts Review**: Comments on the PR with detailed feedback covering:
   - Security vulnerabilities
   - Code quality and maintainability
   - Performance concerns
   - Potential bugs and logic issues
   - Best practices adherence
   - Actionable recommendations

## Review Categories

The AI reviewer analyzes:

### 🔒 Security
- Hardcoded secrets and API key exposure
- SQL injection vulnerabilities
- XSS (Cross-Site Scripting) issues
- Authentication and authorization bypasses
- Input validation problems
- Sensitive data handling

### 💡 Code Quality
- Code structure and organization
- TypeScript best practices
- Error handling patterns
- Maintainability concerns
- Consistency with existing codebase
- Proper use of abstractions

### ⚡ Performance
- Algorithm efficiency
- Memory leaks
- Unnecessary computations
- Database query optimization
- Streaming and async patterns
- Token counting efficiency

### 🐛 Potential Issues
- Logic errors and bugs
- Edge cases
- Race conditions
- Type safety issues
- Null/undefined handling
- Error handling gaps

### ✅ Positive Aspects
- Well-implemented features
- Good practices
- Clever solutions
- Proper documentation

### 📝 Recommendations
- Specific, actionable improvements
- Alternative approaches
- Refactoring suggestions
- Testing recommendations

## Setup

### Prerequisites

1. **OpenRouter API Key**: Get your API key from [OpenRouter](https://openrouter.ai/)
   - Sign up for a free account
   - Navigate to API Keys section
   - Create a new API key
   - Note: The review agent uses a **free model** (`z-ai/glm-4.5-air:free`) by default!

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
     - "Allow GitHub Actions to create and approve pull requests" is checked

3. **Create the Label**:
   - Go to Issues → Labels
   - Click "New label"
   - Name: `ai_code_review`
   - Description: "Request AI code review"
   - Color: Choose any color you like (e.g., purple `#7E57C2`)
   - Click "Create label"

## Usage

### Getting a Review

1. **Create a Pull Request** as normal
2. **Add the Label**: Add the `ai_code_review` label to the PR
3. **Wait for Review**: The workflow will run automatically (takes 1-3 minutes)
4. **Read Feedback**: Review the AI's comments and suggestions
5. **Iterate**: Make changes, push updates, and the review will re-run automatically

### Re-triggering a Review

The review automatically re-runs when:
- You push new commits to the PR (if the label is already applied)
- You add the `ai_code_review` label

To manually re-trigger:
- Remove the `ai_code_review` label
- Add it back again

### When to Use

**Good use cases:**
- Large refactorings
- Security-sensitive changes (auth, API keys, database queries)
- Complex logic or algorithms
- New features with multiple files
- Changes you want a second opinion on

**Less useful for:**
- Very small PRs (1-2 line changes)
- Documentation-only changes
- Automated dependency updates
- Changes over 600KB (will be rejected)

## Customization

You can customize the review agent by modifying `.github/workflows/pr-review.yml`:

```yaml
env:
  AI_MODEL: "z-ai/glm-4.5-air:free"       # Change model here
  AI_TEMPERATURE: "0.2"                    # Lower = more focused (0.0-1.0)
  AI_MAX_TOKENS: "8000"                    # Response length (higher = more detailed)
  MAX_DIFF_SIZE: "600000"                  # Max diff size in bytes (600KB - fits in 131K context)
```

### Available Models (via OpenRouter)

**Free Models:**
- `z-ai/glm-4.5-air:free` (default, **completely free**, great for code review)
- `meta-llama/llama-3.2-3b-instruct:free` (faster, simpler reviews)
- `google/gemini-flash-1.5:free` (good balance)

**Paid Models** (for higher quality reviews):
- `anthropic/claude-3.5-sonnet` (best quality, understands context deeply)
- `anthropic/claude-3-opus` (most thorough)
- `openai/gpt-4-turbo` (excellent for code)

See [OpenRouter models](https://openrouter.ai/models) for the full list.

### Customizing Review Focus

To modify what the reviewer focuses on, edit the prompt in `.github/scripts/pr-review.sh`:

```bash
# Find the REVIEW_PROMPT variable and customize the instructions
REVIEW_PROMPT="Your custom review instructions here..."
```

For example, you could:
- Add project-specific coding standards
- Focus on particular security concerns
- Check for specific patterns or anti-patterns
- Enforce architectural decisions

## Cost Estimation

**Default (Free Model):**
- **Cost: $0** (completely free, unlimited reviews)

**Paid Models:**
- **Small PR** (< 100 lines): ~$0.01 - $0.05 per review
- **Medium PR** (100-500 lines): ~$0.05 - $0.15 per review
- **Large PR** (500-2000 lines): ~$0.15 - $0.50 per review
- Typical monthly cost: **$5-20/month** for active development

## Diff Size Limits

- **Maximum**: 600KB (~6000 lines of code, fits comfortably in the model's 131K token context)
- **Recommended**: Keep PRs under 300KB for best results
- **Tip**: Break large PRs into smaller, focused changes for better reviews

If your diff exceeds the limit:
1. Break the PR into smaller, logical chunks
2. Increase `MAX_DIFF_SIZE` in the workflow (model supports up to ~1MB, but quality may degrade)
3. Use the review selectively on specific commits

## Testing

### Test the PR Review Agent

1. **Create a test branch**:
   ```bash
   git checkout -b test-pr-review
   ```

2. **Make some changes** (add a new feature or refactor something)

3. **Push and create a PR**:
   ```bash
   git push origin test-pr-review
   ```
   Then create a PR on GitHub

4. **Add the label**: Add `ai_code_review` to the PR

5. **Check the workflow**:
   - Go to the Actions tab
   - Watch the "PR Review Agent" workflow run
   - After completion, check the PR for the review comment

### Local Testing

You can test the script locally:

```bash
# Set up environment
export OPENROUTER_API_KEY="your-key-here"
export GITHUB_TOKEN="your-github-token"
export PR_NUMBER="1"
export PR_TITLE="Test PR"
export PR_AUTHOR="testuser"
export PR_DESCRIPTION="Testing the review agent"
export REPO_NAME="your-username/your-repo"
export BASE_BRANCH="main"
export HEAD_BRANCH="test-branch"

# Generate a diff and pipe to the script
git diff main...your-branch | bash .github/scripts/pr-review.sh
```

## Troubleshooting

### Workflow Not Running

- **Check the label**: Ensure `ai_code_review` label exists and is applied
- **Verify Actions enabled**: Settings → Actions → General
- **Check permissions**: Ensure workflows have read/write permissions
- **Review workflow file**: Make sure `.github/workflows/pr-review.yml` is valid YAML

### API Errors

- **"OPENROUTER_API_KEY is not set"**: Add the secret in repository settings
- **"Unauthorized"**: Verify your API key is correct and active
- **"Model not found"**: Check the model name in the workflow environment variables
- **"Rate limit exceeded"**: Wait a few minutes or upgrade OpenRouter plan

### Diff Size Exceeded

If you get "Diff size exceeds 800KB":
- Break your PR into smaller, focused changes
- Review specific commits instead of the entire PR
- Increase `MAX_DIFF_SIZE` in the workflow (may reduce review quality)

### No Review Posted

- Check the Actions log for detailed error messages
- Verify the GitHub token has permission to comment
- Ensure the PR is not from a fork (forks have limited secret access)
- Check if the API response was empty (logged in Actions)

### Poor Review Quality

To improve review quality:
- Use a better model (e.g., Claude 3.5 Sonnet)
- Increase `AI_MAX_TOKENS` for more detailed feedback
- Lower `AI_TEMPERATURE` for more focused reviews (try 0.1)
- Keep PRs smaller and more focused
- Provide better PR descriptions to give context

## Security Considerations

- **Secrets**: Never commit API keys to the repository
- **PR Content**: Code in public PRs is sent to OpenRouter/AI model
- **Private Repos**: Reviews work fine, but data is still sent to third-party API
- **Fork PRs**: Secrets are not available to fork PRs by default (this is a GitHub security feature)
- **Review Accuracy**: Always verify AI suggestions; don't blindly accept them

## Best Practices

1. **Write Good PR Descriptions**: Provide context to help the AI understand your changes
2. **Keep PRs Focused**: Smaller, focused PRs get better reviews
3. **Use Selectively**: Not every PR needs AI review; use for complex or security-sensitive changes
4. **Combine with Human Review**: AI review complements, not replaces, human review
5. **Iterate**: Use the feedback to improve, then push updates for re-review
6. **Learn Patterns**: Pay attention to recurring feedback to improve your code

## Disabling the PR Review Agent

To temporarily disable:

1. **Option 1 - Remove Label**: Simply don't add the `ai_code_review` label to PRs
2. **Option 2 - Disable Workflow**: Edit `.github/workflows/pr-review.yml`:
   ```yaml
   on: []  # Disables all triggers
   ```
3. **Option 3 - Delete**: Remove the workflow file entirely

## Example Output

When a PR is reviewed, the agent posts a comment like:

```markdown
## 🤖 AI Code Review

## Summary
This PR adds OAuth token refresh functionality to the authentication system.
The implementation looks solid with good error handling and logging.

## 🔒 Security
- ✅ No hardcoded secrets detected
- ⚠️ Consider adding rate limiting to the token refresh endpoint
- ✅ Proper input validation on token parameters

## 💡 Code Quality
- ✅ Well-structured code with clear separation of concerns
- ✅ Good TypeScript typing throughout
- 💡 Consider extracting the retry logic into a reusable utility

## ⚡ Performance
- ✅ Efficient token caching implementation
- ⚠️ The token refresh could be batched for multiple simultaneous requests

## 🐛 Potential Issues
- ⚠️ Missing null check on line 45 for `refreshToken` parameter
- ⚠️ Edge case: What happens if token refresh fails during active request?

## ✅ Positive Aspects
- Well-documented functions with JSDoc comments
- Comprehensive error handling
- Good test coverage

## 📝 Recommendations
1. Add null/undefined check for refreshToken parameter
2. Consider implementing exponential backoff for failed refresh attempts
3. Add integration test for concurrent refresh scenarios

---
**Stats:** Diff size: 15234 bytes | Model: z-ai/glm-4.5-air:free

⚠️ **Note**: This is an automated review. Please verify all suggestions.
```

## Contributing

To improve the PR review agent:
1. Modify the prompt in `.github/scripts/pr-review.sh`
2. Adjust review categories and focus areas
3. Test with sample PRs
4. Submit a PR with your improvements (it will review itself! 🤖)

## Support

Issues with the PR review agent:
1. Check the troubleshooting section above
2. Review workflow logs in the Actions tab
3. Open an issue with the `ai_code_review` label (it will triage itself!)
4. Include Action logs and PR details

## Credits

Inspired by similar AI code review implementations and built with OpenRouter's unified API for easy model switching.
