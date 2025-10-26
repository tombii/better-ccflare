# TUI Removal Plan

## Overview

This document outlines the plan for removing the Terminal User Interface (TUI) from better-ccflare while preserving the server and web dashboard functionality.

## Current Architecture Analysis

### Core Infrastructure (Preserved)
- **`packages/core`**: Core business logic, networking, models
- **`packages/database`**: SQLite database operations
- **`packages/config`**: Configuration management
- **`packages/providers`**: OAuth/API providers (Anthropic, z.ai, etc.)
- **`packages/load-balancer`**: Request distribution logic
- **`packages/proxy`**: HTTP proxy functionality
- **`packages/http-api`**: REST API endpoints
- **`packages/errors`**: Error handling

### Server & Web UI (Preserved)
- **`apps/server`**: Main server application (`start` command)
- **`packages/dashboard-web`**: React web dashboard
- **`packages/cli-commands`**: CLI commands for account management

### TUI Components (To be Removed)
- **`apps/tui`**: Terminal UI application using Ink framework
- **`packages/tui-core`**: TUI-specific business logic
- **`packages/ui-common`**: Shared UI components (used by both TUI and web dashboard)

## Key Integration Points

### 1. Main Entry Point (`apps/tui/src/main.ts`)
- Current CLI entry point that handles ALL commands
- Auto-starts server for TUI mode
- Processes both non-interactive commands and interactive TUI
- This is the main integration point between CLI and TUI

### 2. CLI Command Integration
- `packages/cli-commands` handles most account management commands
- `packages/tui-core` duplicates some functionality for TUI-specific commands
- Two parallel CLI systems: one for TUI, one for server-only operations

### 3. Shared Dependencies
- `packages/ui-common` contains shared UI components
- Used by both TUI and web dashboard
- Some components may be TUI-specific (Ink-based)

## TUI Removal Strategy

### Phase 1: Create New CLI Entry Point
1. **Create `apps/cli`**: New CLI application that replaces `apps/tui` as main entry point
2. **Move command logic**: Extract non-TUI command handlers from `apps/tui/main.ts`
3. **Preserve server functionality**: Keep server auto-start functionality
4. **Update package.json**: Change main entry point from `apps/tui` to `apps/cli`

### Phase 2: Remove TUI-Specific Code
1. **Delete TUI apps**: Remove `apps/tui` directory
2. **Remove TUI packages**: Delete `packages/tui-core` and clean up `packages/ui-common`
3. **Update dependencies**: Remove Ink, React, and other TUI dependencies from root package.json
4. **Clean up build scripts**: Remove TUI build targets from scripts

### Phase 3: Refactor Shared Components
1. **Extract common UI**: Move truly shared components from `packages/ui-common` to appropriate packages
2. **Update web dashboard**: Ensure web dashboard still works after TUI removal
3. **Test CLI commands**: Verify all CLI commands work without TUI dependency

### Phase 4: Package Updates
1. **Update npm package**: Remove TUI-specific dependencies from published package
2. **Update documentation**: Remove TUI-related instructions
3. **Update scripts**: Remove TUI build and test scripts

## Detailed Component Analysis

### TUI Dependencies to Remove
From `apps/tui/package.json`:
- `ink`: ^6.0.0
- `ink-select-input`: ^6.0.0
- `ink-spinner`: ^5.0.0
- `ink-text-input`: ^6.0.0
- `react`: ^19.0.0
- `@types/react`: ^19.0.0
- `react-devtools-core`: ^7.0.1

### Files/Directories to Remove
- `apps/tui/` (entire directory)
- `packages/tui-core/` (entire directory)
- TUI-specific components from `packages/ui-common/`

### Files to Create/Modify
- `apps/cli/` (new directory)
- `apps/cli/package.json` (new file)
- `apps/cli/src/main.ts` (new file)
- `package.json` (update scripts and workspace)
- `README.md` (update documentation)

## Preserved Functionality

### ✅ Server Features
- `better-ccflare --serve` - Start server on port 8080
- `better-ccflare --serve --port 8081` - Custom port
- SSL/HTTPS support with `--ssl-key` and `--ssl-cert`
- Web dashboard at `http://localhost:8080`

### ✅ CLI Commands
- `better-ccflare --add-account <name>` - Add account
- `better-ccflare --list` - List accounts
- `better-ccflare --remove <name>` - Remove account
- `better-ccflare --pause <name>` - Pause account
- `better-ccflare --resume <name>` - Resume account
- `better-ccflare --set-priority <name> <priority>` - Set priority
- `better-ccflare --stats` - Show statistics
- `better-ccflare --logs [N]` - Stream logs
- `better-ccflare --reset-stats` - Reset statistics
- `better-ccflare --clear-history` - Clear history
- `better-ccflare --analyze` - Performance analysis
- `better-ccflare --get-model` / `--set-model` - Model management

### ✅ Core Features
- Load balancing across multiple accounts
- OAuth flow management
- Database operations
- Request proxying
- Rate limiting avoidance
- Error handling

## Benefits of This Approach

### 🚀 Performance Improvements
- **Smaller bundle size**: Reduced by ~15-20MB (no React/Ink)
- **Faster startup**: No UI framework initialization overhead
- **Better CLI responsiveness**: Direct command execution

### 🏗️ Architectural Benefits
- **Clean separation**: CLI doesn't depend on UI frameworks
- **Reduced complexity**: Single CLI entry point
- **Simpler maintenance**: One less application to maintain
- **Clear responsibilities**: CLI for commands, web UI for visualization

### 📦 Package Benefits
- **Smaller npm package**: Fewer dependencies
- **Faster installation**: Less to download
- **Reduced attack surface**: Fewer dependencies

## Risk Mitigation

### 🔄 Rollback Strategy
- `old-tui` branch preserves current implementation
- Git tags for version tracking
- Clear documentation for restoration process

### 🧪 Testing Strategy
- Test each CLI command after removal
- Verify server functionality
- Check web dashboard integration
- Performance benchmarking

### 📋 Migration Checklist
- [ ] Create backup branch
- [ ] Test current functionality
- [ ] Implement new CLI
- [ ] Remove TUI components
- [ ] Update dependencies
- [ ] Test all commands
- [ ] Update documentation
- [ ] Update npm package
- [ ] Performance testing

## Implementation Steps

### Step 1: Backup Current State
```bash
git checkout -b old-tui
git push origin old-tui
```

### Step 2: Create Feature Branch
```bash
git checkout main
git checkout -b feature/remove-tui
```

### Step 3: Implement Changes
1. Create new CLI application
2. Move command handlers
3. Remove TUI dependencies
4. Update build system
5. Test thoroughly

### Step 4: Merge to Main
```bash
git checkout main
git merge feature/remove-tui
git push origin main
```

## Version Strategy

### Current Version (with TUI)
- Version: 1.2.39
- Full TUI + Server + Web Dashboard

### After Removal
- Same version (feature removal)
- Server + Web Dashboard only
- Smaller package size

## User Impact

### ✅ No Breaking Changes
- All CLI commands work identically
- Server functionality unchanged
- Web dashboard unchanged
- Configuration files unchanged

### 📚 Documentation Updates
- Remove TUI-related examples
- Update installation instructions
- Clarify server-only usage
- Update troubleshooting guide

## Success Criteria

### ✅ Functional Requirements
- [ ] All CLI commands work without TUI
- [ ] Server starts and runs correctly
- [ ] Web dashboard accessible and functional
- [ ] Account management works
- [ ] Load balancing functions correctly

### ✅ Performance Requirements
- [ ] Package size reduced by 15-20MB
- [ ] CLI startup time improved
- [ ] Memory usage reduced
- [ ] Installation time improved

### ✅ Quality Requirements
- [ ] No regression in functionality
- [ ] All tests pass
- [ ] Documentation updated
- [ ] No broken references

## Future Considerations

### 🔄 Potential Enhancements
- Native CLI help improvements
- Better error messages in CLI
- Enhanced logging capabilities
- Performance monitoring tools

### 📈 Monitoring
- Package download metrics
- User feedback collection
- Performance benchmarking
- Error tracking

---

*Last Updated: 2025-10-24*
*Version: 1.0*
*Status: Planning*