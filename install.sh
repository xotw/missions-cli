#!/usr/bin/env bash
# Missions CLI + MCP installer. Safe to run more than once.
set -e
BASE="https://raw.githubusercontent.com/xotw/missions-cli/main"

# pick a writable bin dir on PATH
BIN=""
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then BIN="$d"; break; fi
done
[ -z "$BIN" ] && { mkdir -p "$HOME/.local/bin"; BIN="$HOME/.local/bin"; }

mkdir -p "$HOME/.config/msn"
echo "Installing msn to $BIN …"
curl -fsSL "$BASE/msn" -o "$BIN/msn" && chmod +x "$BIN/msn"
curl -fsSL "$BASE/mcp-server.js" -o "$HOME/.config/msn/mcp-server.js"

# register the MCP server with Claude Code if present
if command -v claude >/dev/null 2>&1; then
  claude mcp add --scope user missions -- node "$HOME/.config/msn/mcp-server.js" >/dev/null 2>&1 \
    && echo "✓ Registered the 'missions' MCP server with Claude Code." \
    || echo "• MCP already registered (or run: claude mcp add --scope user missions -- node ~/.config/msn/mcp-server.js)"
fi

case ":$PATH:" in *":$BIN:"*) ;; *) echo "• Add $BIN to your PATH (e.g. in ~/.zshrc): export PATH=\"$BIN:\$PATH\"";; esac

echo ""
echo "✓ Installed. Next:"
echo "    msn login your-email@bulldozer-collective.com"
echo "  then restart Claude Code and ask it: \"what's on for today?\""
