#!/bin/bash

# Claude Code WebUI Installer
# This script sets up the environment and dependencies for Claude Code WebUI

set -e

echo "🚀 Starting Claude Code WebUI Installer..."

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js (v18+) and try again."
    exit 1
fi

echo "✅ Node.js detected: $(node -v)"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm and try again."
    exit 1
fi

echo "✅ npm detected: $(npm -v)"

# Install Claude Code CLI if not present
if ! command -v claude &> /dev/null; then
    echo "📦 Installing @anthropic-ai/claude-code globally..."
    npm install -g @anthropic-ai/claude-code || {
        echo "⚠️ Global installation failed. Trying with sudo..."
        sudo npm install -g @anthropic-ai/claude-code
    }
else
    echo "✅ Claude Code CLI is already installed."
fi

# Install project dependencies
echo "📦 Installing project dependencies..."
npm run install:all

# Create default config if missing
if [ ! -f server/config.json ]; then
    echo "📝 Creating default config.json..."
    echo "{}" > server/config.json
fi

echo ""
echo "🎉 Installation complete!"
echo "--------------------------------"
echo "To start the WebUI, run:"
echo "  npm run dev"
echo ""
echo "Then open http://localhost:5173 in your browser."
echo "--------------------------------"
