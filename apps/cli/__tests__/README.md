# CLI Tests

Comprehensive test suite for the better-ccflare CLI application.

## Running Tests

```bash
# Run all tests
bun test

# Run only CLI tests
bun run test:cli

# Run with verbose output
bun test --verbose apps/cli/__tests__
```

## Test Coverage

### Integration Tests (26 tests total)

#### Version Command (3 tests)
- ✅ Display version with `--version` flag
- ✅ Display version with `-v` flag
- ✅ Fast exit performance (< 1s)

#### Help Command (5 tests)
- ✅ Display help with `--help` flag
- ✅ Display help with `-h` flag
- ✅ Show SSL options in help
- ✅ Show account mode options
- ✅ Fast exit performance (< 1s)

#### SSL Certificate Validation (3 tests)
- ✅ Accept valid SSL certificate paths
- ✅ Reject non-existent SSL key file
- ✅ Reject non-existent SSL cert file

#### Add Account Command (2 tests)
- ✅ Reject add account without required flags
- ✅ Show example usage for add account

#### Argument Parsing (2 tests)
- ✅ Parse port number correctly
- ✅ Handle multiple flags

#### Error Handling (2 tests)
- ✅ Handle invalid port gracefully
- ✅ Handle invalid priority gracefully

#### Performance (2 tests)
- ✅ Version command executes quickly (< 1s)
- ✅ Help command executes quickly (< 1s)

#### Unit Tests - Argument Parsing Logic (4 tests)
- ✅ Parse boolean flags correctly
- ✅ Parse flags with values
- ✅ Handle flags in any order
- ✅ Parse set-priority with two arguments

#### Security Tests (3 tests)
- ✅ Do not expose sensitive data in help text
- ✅ Handle path traversal attempts gracefully
- ✅ Sanitize error messages

## Test Results

```
✓ 26 tests passed
✓ 55 expect() assertions
✓ No lint issues
✓ No type errors
✓ Execution time: ~20s
```

## What's Tested

1. **CLI Arguments**: All command-line flags and argument parsing
2. **Fast Exit Paths**: Version and help commands use optimized exit paths
3. **SSL Validation**: File existence checks for SSL certificates
4. **Error Handling**: Graceful handling of invalid inputs
5. **Security**: No exposure of sensitive data, path traversal protection
6. **Performance**: Fast response times for simple commands

## What's NOT Tested (Future Work)

These require a test database and more complex setup:

- Account management commands (--add-account with valid flags, --list, --remove, --pause, --resume)
- Statistics commands (--stats, --reset-stats, --clear-history)
- Performance analysis (--analyze)
- Model configuration (--get-model, --set-model)
- Server startup with database initialization

## Notes

- Tests use Bun's built-in test runner
- Integration tests spawn actual CLI processes
- Timeouts are set to prevent hanging on server commands
- Temporary files are cleaned up after each test
