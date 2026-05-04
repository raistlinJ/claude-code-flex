#!/usr/bin/env bash

# Claude Code WebUI Installer
# Sets up required tools and project dependencies for local development.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OS="$(uname -s)"

echo "Starting Claude Code WebUI installer..."

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

run_with_sudo_if_needed() {
    if command_exists sudo; then
        sudo "$@"
    else
        "$@"
    fi
}

install_with_brew() {
    if ! command_exists brew; then
        echo "Homebrew is required on macOS for automatic dependency install."
        echo "Install Homebrew first, then re-run this script: https://brew.sh"
        exit 1
    fi

    brew install "$@"
}

install_with_linux_pkg_manager() {
    if command_exists apt-get; then
        run_with_sudo_if_needed apt-get update
        run_with_sudo_if_needed apt-get install -y "$@"
    elif command_exists dnf; then
        run_with_sudo_if_needed dnf install -y "$@"
    elif command_exists yum; then
        run_with_sudo_if_needed yum install -y "$@"
    elif command_exists pacman; then
        run_with_sudo_if_needed pacman -Sy --noconfirm "$@"
    elif command_exists zypper; then
        run_with_sudo_if_needed zypper --non-interactive install "$@"
    else
        echo "No supported Linux package manager found (apt/dnf/yum/pacman/zypper)."
        echo "Please install required dependencies manually and re-run."
        exit 1
    fi
}

ensure_node_and_npm() {
    if command_exists node && command_exists npm; then
        echo "Node.js detected: $(node -v)"
        echo "npm detected: $(npm -v)"
        return
    fi

    echo "Installing Node.js and npm..."
    case "$OS" in
        Darwin)
            install_with_brew node
            ;;
        Linux)
            if command_exists apt-get; then
                install_with_linux_pkg_manager nodejs npm
            elif command_exists pacman; then
                install_with_linux_pkg_manager nodejs npm
            else
                install_with_linux_pkg_manager nodejs npm
            fi
            ;;
        MINGW*|MSYS*|CYGWIN*)
            echo "Automatic Node.js/npm install is not handled in this shell on Windows."
            echo "Install Node.js from https://nodejs.org and re-run this script."
            exit 1
            ;;
        *)
            echo "Unsupported OS: $OS"
            exit 1
            ;;
    esac

    if ! command_exists node || ! command_exists npm; then
        echo "Failed to install Node.js/npm automatically."
        exit 1
    fi

    echo "Node.js detected: $(node -v)"
    echo "npm detected: $(npm -v)"
}

ensure_claude_cli() {
    if command_exists claude; then
        echo "Claude Code CLI detected: $(claude --version 2>/dev/null || echo 'installed')"
        return
    fi

    echo "Installing Claude Code CLI (@anthropic-ai/claude-code)..."
    npm install -g @anthropic-ai/claude-code || run_with_sudo_if_needed npm install -g @anthropic-ai/claude-code

    if ! command_exists claude; then
        echo "Claude Code CLI installation did not complete successfully."
        exit 1
    fi

    echo "Claude Code CLI detected: $(claude --version 2>/dev/null || echo 'installed')"
}

ensure_native_terminal_dependencies() {
    case "$OS" in
        Darwin)
            if ! command_exists osascript; then
                echo "osascript is missing; native terminal launch on macOS may fail."
            fi
            ;;
        Linux)
            if ! command_exists x-terminal-emulator; then
                echo "Installing Linux terminal launcher dependency (x-terminal-emulator provider)..."
                if command_exists apt-get; then
                    install_with_linux_pkg_manager xterm
                elif command_exists dnf || command_exists yum; then
                    install_with_linux_pkg_manager xterm
                elif command_exists pacman; then
                    install_with_linux_pkg_manager xterm
                elif command_exists zypper; then
                    install_with_linux_pkg_manager xterm
                else
                    echo "Could not install terminal launcher automatically."
                fi
            fi

            if command_exists x-terminal-emulator; then
                echo "Linux native terminal launcher detected: x-terminal-emulator"
            else
                echo "Warning: x-terminal-emulator is not available."
                echo "Native terminal launch may fail; web terminal will still work."
            fi
            ;;
        MINGW*|MSYS*|CYGWIN*)
            if ! command_exists powershell.exe; then
                echo "Warning: powershell.exe not found. Native terminal launch on Windows may fail."
            fi
            ;;
    esac
}

ensure_local_runtime_files() {
    if [ ! -f server/config.json ]; then
        echo "Creating default server/config.json..."
        echo "{}" > server/config.json
    fi

    if [ ! -f server/cert.pem ] || [ ! -f server/key.pem ]; then
        echo "Generating local TLS certs..."
        (cd server && ./generate-certs.sh)
    fi
}

ensure_node_and_npm
ensure_claude_cli
ensure_native_terminal_dependencies

echo "Installing project dependencies..."
npm run install:all

ensure_local_runtime_files

echo ""
echo "Installation complete."
echo "--------------------------------"
echo "To start the WebUI, run:"
echo "  npm run dev"
echo ""
echo "For LAN/mobile testing, run client with:"
echo "  npm --prefix client run dev -- --host 0.0.0.0"
echo "--------------------------------"
