/**
 * Get help text for CLI commands
 */
export function getHelpText(): string {
	return `
Usage: better-ccflare <command> [options]

Commands:
  add <name> [--mode <max|console|zai|openai-compatible|anthropic-compatible>] [--priority <number>] [--modelMappings <JSON>]
    Add a new account using OAuth or API key
    --mode: Account type (optional, will prompt if not provided)
      max: Claude CLI account (OAuth)
      console: Claude API account (OAuth)
      zai: z.ai account (API key)
      openai-compatible: OpenAI-compatible provider (API key)
      anthropic-compatible: Anthropic-compatible provider (API key)
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

  help
    Show this help message

Examples:
  better-ccflare add myaccount --mode max --priority 10
  better-ccflare add anthropic-account --mode anthropic-compatible --priority 5 --modelMappings '{"opus":"claude-3-opus","sonnet":"claude-3-sonnet"}'
  better-ccflare list
  better-ccflare remove myaccount
  better-ccflare pause myaccount
  better-ccflare resume myaccount
  better-ccflare set-priority myaccount 20
`;
}
