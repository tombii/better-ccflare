/**
 * Get help text for CLI commands
 */
export function getHelpText(): string {
	return `
Usage: better-ccflare <command> [options]

Commands:
  add <name> [--mode <claude-oauth|console|zai|minimax|anthropic-compatible|openai-compatible|nanogpt|kilo|openrouter>] [--priority <number>] [--modelMappings <JSON>]
    Add a new account using OAuth or API key
    --mode: Account type (optional, will prompt if not provided)
      claude-oauth: Claude CLI OAuth account (OAuth)
      console: Claude API account (OAuth)
      zai: z.ai account (API key)
      minimax: Minimax account (API key)
      anthropic-compatible: Anthropic-compatible provider (API key)
      openai-compatible: OpenAI-compatible provider (API key)
      nanogpt: NanoGPT provider (API key)
      kilo: Kilo Gateway provider (API key)
      openrouter: OpenRouter provider (API key)
    --priority: Account priority (0-100, default 0, lower numbers = higher priority)
    --modelMappings: Model mappings as JSON string (e.g., '{"opus":"my-opus-model","sonnet":"my-sonnet-model"}')

  list
    List all accounts with their details

  remove <name> [--force]
    Remove an account
    --force: Skip confirmation prompt

  pause <name>
    Pause an account to exclude it from load balancing

  resume <name>
    Resume a paused account to include it in load balancing

  set-priority <name> <priority>
    Set the priority of an account
    --priority: Account priority (0-100, lower numbers = higher priority)

  reset-stats
    Reset request counts for all accounts

  clear-history
    Clear request history

  analyze
    Analyze database performance and index usage

  token-health
    Check OAuth token health and expiration status
    Shows detailed information about access tokens and refresh tokens

  reauth-needed
    Quick check for accounts that need re-authentication
    Shows only accounts that require immediate attention

  help
    Show this help message

Examples:
  better-ccflare add myaccount --mode claude-oauth --priority 10
  better-ccflare add anthropic-account --mode anthropic-compatible --priority 5 --modelMappings '{"opus":"claude-3-opus","sonnet":"claude-3-sonnet"}'
  better-ccflare add "My Account" --mode claude-oauth --priority 10  # Account names with spaces must be quoted
  better-ccflare list
  better-ccflare remove myaccount
  better-ccflare pause "My Account"  # Use quotes for names with spaces
  better-ccflare resume myaccount
  better-ccflare set-priority myaccount 20
  better-ccflare token-health
  better-ccflare reauth-needed

Note: Account names can contain letters, numbers, spaces, hyphens, and underscores.
      When using names with spaces, wrap them in quotes (e.g., "My Account").
`;
}
