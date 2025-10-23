# Architecture Support Guide

## Supported Platforms

The following pre-compiled binaries are available:

| Platform | Architecture | Binary | Status |
|----------|-------------|--------|--------|
| Linux | x86_64 | `better-ccflare-linux-amd64` | ✅ Supported |
| Linux | ARM64 (aarch64) | `better-ccflare-linux-arm64` | ✅ Supported |
| macOS | Intel (x64) | `better-ccflare-macos-x86_64` | ✅ Supported |
| macOS | Apple Silicon (ARM64) | `better-ccflare-macos-arm64` | ✅ Supported |
| Windows | x86_64 | `better-ccflare-windows-x64.exe` | ✅ Supported |

## Device Compatibility

### ✅ Fully Supported Devices

#### Cloud Providers
- **Oracle Cloud ARM instances** (Ampere Altra - ARM64)
- **AWS Graviton** (ARM64)
- **Azure ARM-based VMs** (ARM64)
- **Any x86_64 Linux/Windows server**
- **Any Intel or Apple Silicon Mac**

#### Raspberry Pi (64-bit OS)
- **Raspberry Pi 3** (running 64-bit OS)
- **Raspberry Pi 4** (running 64-bit OS)
- **Raspberry Pi 5** (running 64-bit OS)

### ❌ Not Supported (ARM32)

Bun does not currently support 32-bit ARM architectures. The following devices **cannot** run the compiled binaries:

- **Raspberry Pi Zero / Zero W** (ARMv6 - 32-bit)
- **Raspberry Pi 1** (ARMv6 - 32-bit)
- **Raspberry Pi 2** (ARMv7 - 32-bit)
- **Raspberry Pi 3/4** (when running 32-bit Raspberry Pi OS)
- **Any other ARM32 device**

## Installing 64-bit OS on Raspberry Pi

To use the ARM64 binary on Raspberry Pi 3, 4, or 5:

1. Download **Raspberry Pi OS (64-bit)**
2. Flash to SD card using Raspberry Pi Imager
3. Boot and install the `better-ccflare-linux-arm64` binary

## Alternative for ARM32 Devices

If you must run on ARM32 devices, you can run from source using Bun:

```bash
# Install Bun (if available for your platform)
curl -fsSL https://bun.com/install | bash

# Clone the repository
git clone https://github.com/tombii/better-ccflare.git
cd better-ccflare

# Install dependencies
bun install

# Run from source
bun run apps/tui/src/main.ts
```

**Note**: Bun runtime itself may not be available for ARM32. Check https://bun.sh for current platform support.

## Building Multi-Architecture Binaries

To build all supported architectures:

```bash
cd apps/tui
bun run build:multi
```

Or build for specific platforms:

```bash
bun run build:linux-amd64      # Linux x86_64
bun run build:linux-arm64    # Linux ARM64 (Oracle Cloud, Pi 3/4/5)
bun run build:macos-x86_64      # macOS Intel
bun run build:macos-arm64    # macOS Apple Silicon
bun run build:windows-x64    # Windows x86_64
```

## Verifying Your Architecture

To check your system architecture:

```bash
# Linux/macOS
uname -m

# Outputs:
# x86_64    -> Use x64 binary
# aarch64   -> Use arm64 binary
# armv7l    -> Not supported (32-bit ARM)
# armv6l    -> Not supported (32-bit ARM)
```

## Oracle Cloud Specific Notes

Oracle Cloud's ARM instances use **Ampere Altra** processors (ARM64), which are fully supported:

```bash
# On Oracle Cloud ARM instance:
wget https://github.com/tombii/better-ccflare/releases/download/vX.X.X/better-ccflare-linux-arm64
chmod +x better-ccflare-linux-arm64
./better-ccflare-linux-arm64 --version
```
