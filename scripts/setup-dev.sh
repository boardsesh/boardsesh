#!/bin/bash

set -e

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Emoji for better UX
ROCKET="🚀"
DATABASE="🗃️"
PACKAGE="📦"
CHECK="✅"
WARNING="⚠️"
ERROR="❌"

echo -e "${BLUE}${ROCKET} Welcome to Boardsesh Development Setup!${NC}"
echo -e "This script will set up everything you need to contribute to Boardsesh."
echo ""

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to check if Docker is running
docker_running() {
    docker info >/dev/null 2>&1
}

# Function to print step headers
print_step() {
    echo -e "\n${BLUE}$1${NC}"
    echo "$(printf '=%.0s' {1..50})"
}

# Function to print success
print_success() {
    echo -e "${GREEN}${CHECK} $1${NC}"
}

# Function to print warning
print_warning() {
    echo -e "${YELLOW}${WARNING} $1${NC}"
}

# Function to print error and exit
print_error() {
    echo -e "${RED}${ERROR} $1${NC}"
    exit 1
}

print_step "Step 1: Checking Prerequisites"

# Check Node.js
if ! command_exists node; then
    print_error "Node.js is not installed. Please install Node.js 18+ from https://nodejs.org/"
fi

# Check bun
if ! command_exists bun; then
    print_error "Bun is not installed. Please install Bun from https://bun.sh/"
fi

# Check Docker
if ! command_exists docker; then
    print_error "Docker is not installed. Please install Docker from https://docker.com/"
fi

if ! docker_running; then
    print_error "Docker is not running. Please start Docker Desktop and try again."
fi

# Check Docker Compose
if ! command_exists docker-compose && ! docker compose version >/dev/null 2>&1; then
    print_error "Docker Compose is not installed. Please install Docker Compose."
fi

# Check jq for JSON parsing
if ! command_exists jq; then
    print_warning "jq is not installed. It's needed for Aurora API token setup."
    echo "You can install it with: brew install jq (macOS) or apt-get install jq (Ubuntu)"
    echo "Aurora token setup will be skipped if jq is not available."
fi

# Get Node.js version
NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    print_error "Node.js version 18+ is required. You have version $(node --version)"
fi

print_success "All prerequisites are installed"
print_success "Node.js version: $(node --version)"
print_success "Docker version: $(docker --version | cut -d' ' -f3 | cut -d',' -f1)"

print_step "Step 2: Installing Vite+"

if command_exists vp; then
    print_success "Vite+ already installed: $(vp --version 2>/dev/null || echo 'version unknown')"
else
    echo "Installing Vite+ (unified toolchain for testing, linting, formatting)..."
    echo "Windows users: run 'irm https://vite.plus/ps1 | iex' in PowerShell instead."
    if ! curl -fsSL https://vite.plus | bash; then
        print_warning "Failed to install Vite+ automatically."
        echo "Please install it manually:"
        echo "  macOS/Linux: curl -fsSL https://vite.plus | bash"
        echo "  Windows:     irm https://vite.plus/ps1 | iex"
        echo "Then re-run this script."
        exit 1
    fi
    # Source the env file the installer writes so vp is available immediately
    # shellcheck source=/dev/null
    [ -f "$HOME/.vite-plus/env" ] && . "$HOME/.vite-plus/env"
    print_success "Vite+ installed successfully"
fi

echo "Setting up Git hooks..."
vp config
print_success "Git hooks installed (pre-commit will run vp staged)"

# Install the Conventional Commit message hook alongside vp's generated
# pre-commit, without touching core.hooksPath (vp owns that file). Resolving the
# hooks dir via git rev-parse handles worktrees and custom layouts.
HOOKS_DIR=$(git -C "$REPO_ROOT" rev-parse --git-path hooks 2>/dev/null)
if [ -n "$HOOKS_DIR" ] && [ -f "$REPO_ROOT/.githooks/commit-msg" ]; then
    mkdir -p "$HOOKS_DIR"
    cp "$REPO_ROOT/.githooks/commit-msg" "$HOOKS_DIR/commit-msg"
    chmod +x "$HOOKS_DIR/commit-msg"
    print_success "commit-msg hook installed (Conventional Commit check)"
    print_warning "Local hooks are best-effort across git worktrees — CI's commit-lint job is the authoritative gate."
else
    print_warning "Could not resolve a hooks dir; skipping commit-msg hook (CI still enforces it)."
fi

print_step "Step 3: Installing Dependencies"

echo "Installing packages..."
if ! vp install; then
    print_error "Failed to install dependencies"
fi
print_success "Dependencies installed successfully"

print_step "Step 4: Setting Up Environment"

# .env.local lives in packages/web/ and is tracked in git — nothing to create
print_success "Generic environment file already exists (packages/web/.env.local)"

# Create packages/web/.env.development.local if it doesn't exist (secrets only)
SECRETS_ENV="$REPO_ROOT/packages/web/.env.development.local"
if [ ! -f "$SECRETS_ENV" ]; then
    echo "Creating $SECRETS_ENV for secrets..."
    cat > "$SECRETS_ENV" << 'EOF'
# Development secrets - DO NOT COMMIT TO GIT
# This file should contain only sensitive tokens and keys
# Generic configuration is in packages/web/.env.local (tracked in git)

# Aurora API tokens for shared sync
# KILTER_SYNC_TOKEN=your_kilter_token_here
# TENSION_SYNC_TOKEN=your_tension_token_here
EOF
    print_success "Secrets environment file created"
else
    print_success "Secrets environment file already exists"
fi

print_step "Step 5: Setting Up Aurora API Tokens (Optional)"

echo "For shared sync to work, you'll need Aurora API tokens."
echo "These tokens are optional - you can skip this step and add them later."
echo ""

# Function to get Aurora token
get_aurora_token() {
    local board_name="$1"
    local board_url="$2"

    echo -e "${BLUE}Getting $board_name token...${NC}" >&2
    echo "Please enter your $board_name credentials:" >&2

    read -p "Username: " username
    read -s -p "Password: " password
    echo "" >&2

    echo "Fetching token from Aurora API..." >&2

    local payload
    payload=$(jq -n --arg u "$username" --arg p "$password" \
        '{"username":$u,"password":$p,"tou":"accepted","pp":"accepted","ua":"app"}')

    local token_response
    token_response=$(curl -s -X POST "$board_url/sessions" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json" \
        -H "User-Agent: Kilter%20Board/202 CFNetwork/1568.100.1 Darwin/24.0.0" \
        -H "Accept-Language: en-AU,en;q=0.9" \
        -H "Accept-Encoding: gzip, deflate, br" \
        -H "Connection: keep-alive" \
        -d "$payload")

    if [ $? -eq 0 ]; then
        local token
        token=$(echo "$token_response" | jq -r '.session.token // empty')
        if [ -n "$token" ] && [ "$token" != "null" ]; then
            echo "$token"
            return 0
        else
            echo "Error: Failed to get token. Check your credentials." >&2
            return 1
        fi
    else
        echo "Error: Failed to connect to Aurora API" >&2
        return 1
    fi
}

# Ask user if they want to set up tokens
if ! command_exists jq; then
    echo -e "${YELLOW}jq is not available, skipping Aurora API token setup${NC}"
    echo "You can install jq and run the setup again, or add tokens manually to packages/web/.env.development.local"
else
    echo -e "${YELLOW}Do you want to set up Aurora API tokens now? (y/n)${NC}"
    read -r setup_tokens
fi

if [[ "$setup_tokens" =~ ^[Yy]$ ]] && command_exists jq; then
    echo ""
    echo "Setting up Aurora API tokens..."

    # Kilter token
    echo ""
    echo -e "${BLUE}Setting up Kilter Board token...${NC}"
    echo "Visit https://kilterboardapp.com if you need to create an account."
    kilter_token=$(get_aurora_token "Kilter" "https://kilterboardapp.com")

    if [ $? -eq 0 ]; then
        print_success "Kilter token obtained successfully"
        # Remove commented line and add actual token
        sed -i.bak '/^# KILTER_SYNC_TOKEN=/d' "$SECRETS_ENV"
        echo "KILTER_SYNC_TOKEN=$kilter_token" >> "$SECRETS_ENV"
        rm -f "$SECRETS_ENV.bak"
    else
        print_warning "Failed to get Kilter token - you can add it manually later"
    fi

    # Tension token
    echo ""
    echo -e "${BLUE}Setting up Tension Board token...${NC}"
    echo "Visit https://tensionboardapp2.com if you need to create an account."
    tension_token=$(get_aurora_token "Tension" "https://tensionboardapp2.com")

    if [ $? -eq 0 ]; then
        print_success "Tension token obtained successfully"
        # Remove commented line and add actual token
        sed -i.bak '/^# TENSION_SYNC_TOKEN=/d' "$SECRETS_ENV"
        echo "TENSION_SYNC_TOKEN=$tension_token" >> "$SECRETS_ENV"
        rm -f "$SECRETS_ENV.bak"
    else
        print_warning "Failed to get Tension token - you can add it manually later"
    fi

    echo ""
    print_success "Aurora API tokens setup complete"
    echo "Tokens have been added to packages/web/.env.development.local"
else
    echo ""
    print_warning "Skipping Aurora API tokens setup"
    echo "You can add them manually later to packages/web/.env.development.local:"
    echo "  KILTER_SYNC_TOKEN=your_kilter_token"
    echo "  TENSION_SYNC_TOKEN=your_tension_token"
fi

print_step "Step 6: Setting Up Database"

echo "Starting database (pulls pre-built image on first run, starts in seconds after)..."
cd "$REPO_ROOT"
if ! vp run db:up; then
    print_error "Failed to start database"
fi
print_success "Database is ready (test user: test@boardsesh.com / test)"

print_step "Step 7: Installing Playwright Browsers"

echo "Downloading Chromium for e2e tests (~280 MB first run, cached after)..."
if ! (cd packages/web && bunx playwright install chromium); then
    print_warning "Failed to install Playwright browsers — you can run 'cd packages/web && bunx playwright install chromium' later."
else
    print_success "Playwright browsers installed"
fi

echo ""
echo -e "${GREEN}${ROCKET} Setup Complete! ${ROCKET}${NC}"
echo ""
echo "You can now start developing:"
echo ""
echo -e "${BLUE}Start the development server:${NC}"
echo "  vp run dev"
echo ""
echo -e "${BLUE}View your database:${NC}"
echo "  bunx drizzle-kit studio"
echo ""
echo -e "${BLUE}Format code:${NC}"
echo "  vp fmt"
echo ""
echo -e "${BLUE}Need help?${NC}"
echo "  Check CLAUDE.md for development guidelines"
echo "  Visit http://localhost:3000 once dev server is running"
echo ""
echo -e "${GREEN}Happy coding! ${CHECK}${NC}"
