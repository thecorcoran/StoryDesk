#!/usr/bin/env bash
# macOS double-clickable launcher for Story Desk Cloudflare Pages deployment
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/deploy.sh"
echo ""
read -p "Press Enter to exit..."

