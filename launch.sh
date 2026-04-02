#!/bin/bash
# Diphoria AI — one-click launcher
# Double-click this file or run: ./launch.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "🚀 Starting Diphoria AI..."

# Ensure Ollama is running (try multiple methods)
if ! curl -s http://127.0.0.1:11434/api/tags > /dev/null 2>&1; then
  echo "⚙ Starting Ollama..."
  brew services start ollama 2>/dev/null || \
  open -a Ollama 2>/dev/null || \
  /opt/homebrew/bin/ollama serve &
  sleep 2  # give it time to start
fi

# Pull llama3.2:3b if not present (smallest, fastest model)
if ! ollama list 2>/dev/null | grep -q "llama3.2:3b"; then
  echo "📦 Downloading llama3.2:3b (2GB, one-time setup)..."
  ollama pull llama3.2:3b
fi

echo "✓ Ollama ready. Launching app..."
npm start
