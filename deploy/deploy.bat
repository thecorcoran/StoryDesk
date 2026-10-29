@echo off
setlocal enabledelayedexpansion

:: ==============================================================================
:: Story Desk - One-Click Cloudflare Pages Deployment (Windows)
:: ==============================================================================

echo ==================================================
echo 🚀 Story Desk Family Blog Deployment
echo ==================================================

cd /d "%~dp0"
set "CONFIG_FILE=%~dp0deploy.config"

if not exist "%CONFIG_FILE%" (
  echo ⚠️ Configuration file not found: deploy.config
  echo.
  echo Please create it by copying deploy.config.example:
  echo   copy deploy.config.example deploy.config
  echo Then edit deploy.config with your PROJECT_NAME and SITE_DIR.
  echo ==================================================
  pause
  exit /b 1
)

:: Read deploy.config (ignore comments and blank lines)
for /f "usebackq tokens=1,* delims==" %%A in ("%CONFIG_FILE%") do (
  set "line=%%A"
  if not "!line:~0,1!"=="#" (
    set "key=%%A"
    set "val=%%B"
    :: Strip leading/trailing quotes and spaces
    for /f "tokens=* delims= " %%X in ("!key!") do set "key=%%X"
    for /f "tokens=* delims= " %%Y in ("!val!") do set "val=%%Y"
    if defined val (
      set "val=!val:"=!"
      if "!key!"=="PROJECT_NAME" set "PROJECT_NAME=!val!"
      if "!key!"=="SITE_DIR" set "SITE_DIR=!val!"
      if "!key!"=="BRANCH" set "BRANCH=!val!"
    )
  )
)

if not defined BRANCH set "BRANCH=main"

if not defined PROJECT_NAME (
  echo ❌ Error: PROJECT_NAME is not set in deploy.config
  pause
  exit /b 1
)

if not defined SITE_DIR (
  echo ❌ Error: SITE_DIR is not set in deploy.config
  pause
  exit /b 1
)

:: Check for Node.js / npx
where npx >nul 2>nul
if %errorlevel% neq 0 (
  echo ❌ Error: Node.js and npx are required for deployment but not found.
  echo Please install Node.js from: https://nodejs.org/
  pause
  exit /b 1
)

if not exist "%SITE_DIR%" (
  echo ❌ Error: Site directory not found at:
  echo    %SITE_DIR%
  echo.
  echo 👉 In Story Desk, click '🔒 Dad', enter your secret word,
  echo    and click '🚀 Publish Family Site' to generate your site files first!
  pause
  exit /b 1
)

echo Deploying site from: %SITE_DIR%
echo Target Cloudflare Project: %PROJECT_NAME%
echo Production Branch: %BRANCH%
echo.

call npx wrangler pages deploy "%SITE_DIR%" --project-name "%PROJECT_NAME%" --branch "%BRANCH%"

if %errorlevel% equ 0 (
  echo.
  echo ==================================================
  echo 🎉 Deployment Successful!
  echo Your family blog is live at:
  echo 👉 https://%PROJECT_NAME%.pages.dev
  echo ==================================================
) else (
  echo.
  echo ❌ Deployment failed.
  echo.
  echo First-time setup tips:
  echo 1. Log in to Cloudflare with Wrangler:
  echo    npx wrangler login
  echo 2. Create your Pages project:
  echo    npx wrangler pages project create %PROJECT_NAME% --production-branch %BRANCH%
  echo ==================================================
)

pause

