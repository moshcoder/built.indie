#!/bin/sh
# built.indie CLI, TUI and MCP server: curl -fsSL https://built.indie.pit.world/install.sh | sh
# Installs @profullstack/builtindie with bun when you have it, else npm (Node 22+).
# No sudo: npm falls back to ~/.local. Run it again to upgrade.
set -eu

PKG="@profullstack/builtindie"
say() { printf '\033[1;31m▲\033[0m %s\n' "$*"; }
die() { printf 'built.indie install: %s\n' "$*" >&2; exit 1; }

if command -v bun >/dev/null 2>&1; then
  # bun add -g writes into the nearest package.json above its global dir when that dir has none.
  GLOBAL="${BUN_INSTALL:-$HOME/.bun}/install/global"
  mkdir -p "$GLOBAL"
  [ -f "$GLOBAL/package.json" ] || printf '{}\n' > "$GLOBAL/package.json"
  say "Installing $PKG with bun"
  bun add -g "$PKG@latest" >/dev/null
  BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
elif command -v npm >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$NODE_MAJOR" -ge 22 ] || die "needs Node 22 or newer (you have $(node -v 2>/dev/null || echo none)), or bun: curl -fsSL https://bun.sh/install | bash"
  # builtindie runs on bun; npm installs the launcher, which needs bun on PATH.
  command -v bun >/dev/null 2>&1 || say "Note: builtindie runs on bun. Install it too: curl -fsSL https://bun.sh/install | bash"
  PREFIX=$(npm config get prefix 2>/dev/null || echo /usr/local)
  if [ -w "$PREFIX" ] || [ -w "$PREFIX/lib/node_modules" ] 2>/dev/null; then
    say "Installing $PKG with npm"
    npm install -g "$PKG@latest" >/dev/null
    BIN_DIR="$PREFIX/bin"
  else
    say "Installing $PKG with npm into ~/.local"
    npm install -g --prefix "$HOME/.local" "$PKG@latest" >/dev/null
    BIN_DIR="$HOME/.local/bin"
  fi
else
  die "needs bun or npm. Get bun: curl -fsSL https://bun.sh/install | bash"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add $BIN_DIR to your PATH: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

say "Done. Try: builtindie top    (or builtindie launch yourproduct.com)"
say "MCP: claude mcp add builtindie -- builtindie mcp"
