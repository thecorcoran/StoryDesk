#!/usr/bin/env bash
# ==============================================================================
# Story Desk - One-Click Cloudflare Pages Deployment (Linux & macOS)
# ==============================================================================

set -e

# Change directory to this script's folder
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CONFIG_FILE="$SCRIPT_DIR/deploy.config"

echo "=================================================="
echo "🚀 Story Desk Family Blog Deployment"
echo "=================================================="

# Check if deploy.config exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo "⚠️ Configuration file not found: deploy.config"
  echo ""
  echo "Please create it by copying deploy.config.example:"
  echo "  cp deploy.config.example deploy.config"
  echo "Then edit deploy.config with your PROJECT_NAME and SITE_DIR."
  echo "=================================================="
  exit 1
fi

# Load configuration
source "$CONFIG_FILE"

if [ -z "$PROJECT_NAME" ]; then
  echo "❌ Error: PROJECT_NAME is not set in deploy.config"
  exit 1
fi

if [ -z "$SITE_DIR" ]; then
  echo "❌ Error: SITE_DIR is not set in deploy.config"
  exit 1
fi

BRANCH="${BRANCH:-main}"

# Check for Node.js / npx
if ! command -v npx >/dev/null 2>&1; then
  echo "❌ Error: Node.js and npx are required for deployment but not found."
  echo "Please install Node.js from: https://nodejs.org/"
  exit 1
fi

# Resolve SITE_DIR path (relative to script or absolute)
if [[ "$SITE_DIR" != /* ]]; then
  RESOLVED_SITE_DIR="$SCRIPT_DIR/$SITE_DIR"
else
  RESOLVED_SITE_DIR="$SITE_DIR"
fi

if [ ! -d "$RESOLVED_SITE_DIR" ]; then
  echo "❌ Error: Site directory not found at:"
  echo "   $RESOLVED_SITE_DIR"
  echo ""
  echo "👉 In Story Desk, click '🔒 Dad', enter your secret word,"
  echo "   and click '🚀 Publish Family Site' to generate your site files first!"
  exit 1
fi

if [ ! -f "$RESOLVED_SITE_DIR/index.html" ]; then
  echo "⚠️ Warning: index.html not found inside $RESOLVED_SITE_DIR."
  echo "Make sure you ran 'Publish Family Site' in Story Desk."
fi

echo "Deploying site from: $RESOLVED_SITE_DIR"
echo "Target Cloudflare Project: $PROJECT_NAME"
echo "Production Branch: $BRANCH"
echo ""

# Run Wrangler Pages Deploy
# Uses npx wrangler pages deploy [DIRECTORY] --project-name <PROJECT_NAME> --branch <BRANCH>
# Specifying --branch main ensures deployment deploys directly to the production branch without preview URLs.
if npx wrangler pages deploy "$RESOLVED_SITE_DIR" --project-name "$PROJECT_NAME" --branch "$BRANCH"; then
  echo ""
  echo "=================================================="
  echo "🎉 Deployment Successful!"
  echo "Your family blog is live at:"
  echo "👉 https://${PROJECT_NAME}.pages.dev"
  echo "=================================================="
else
  echo ""
  echo "❌ Deployment failed."
  echo ""
  echo "First-time setup tips:"
  echo "1. Log in to Cloudflare with Wrangler:"
  echo "   npx wrangler login"
  echo "2. Create your Pages project (if not created yet):"
  echo "   npx wrangler pages project create $PROJECT_NAME --production-branch $BRANCH"
  echo "=================================================="
  exit 1
fi

