#!/bin/bash

set -e

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

print_step "Step 2: Installing Dependencies"

echo "Installing packages with Bun..."
if ! bun install; then
    print_error "Failed to install dependencies"
fi
print_success "Dependencies installed successfully"

print_step "Step 3: Setting Up Environment"

# Create .env.local if it doesn't exist (generic config)
if [ ! -f ".env.local" ]; then
    echo "Creating .env.local file..."
    cat > .env.local << 'EOF'
# Generic configuration for development
# This file is tracked in git and should NOT contain secrets

VERCEL_ENV=development
POSTGRES_URL=postgresql://postgres:password@localhost:54320/verceldb
DATABASE_URL=postgresql://postgres:password@localhost:54320/verceldb
BASE_URL=http://localhost:3000
POSTGRES_HOST=localhost
POSTGRES_PORT=54320
POSTGRES_USER=postgres
POSTGRES_PASSWORD=password
POSTGRES_DATABASE=verceldb
IRON_SESSION_PASSWORD={ "1": "68cJgCDE39gaXwi8LTVW4WioyhGxwcAd" }
EOF
    print_success "Generic environment file created"
else
    print_success "Generic environment file already exists"
fi

# Create .env.development.local if it doesn't exist (secrets only)
if [ ! -f ".env.development.local" ]; then
    echo "Creating .env.development.local file for secrets..."
    cat > .env.development.local << 'EOF'
# Development secrets - DO NOT COMMIT TO GIT
# This file should contain only sensitive tokens and keys
# Generic configuration goes in .env.local

# Aurora API tokens for shared sync
# KILTER_SYNC_TOKEN=your_kilter_token_here
# TENSION_SYNC_TOKEN=your_tension_token_here
EOF
    print_success "Secrets environment file created"
else
    print_success "Secrets environment file already exists"
fi

print_step "Step 4: Setting Up Aurora API Tokens (Optional)"

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
    
    local token_response=$(curl -s -X POST "$board_url/sessions" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json" \
        -H "User-Agent: Kilter%20Board/202 CFNetwork/1568.100.1 Darwin/24.0.0" \
        -H "Accept-Language: en-AU,en;q=0.9" \
        -H "Accept-Encoding: gzip, deflate, br" \
        -H "Connection: keep-alive" \
        -d "{\"username\":\"$username\",\"password\":\"$password\",\"tou\":\"accepted\",\"pp\":\"accepted\",\"ua\":\"app\"}")
    
    if [ $? -eq 0 ]; then
        local token=$(echo "$token_response" | jq -r '.session.token // empty')
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
    echo "You can install jq and run the setup again, or add tokens manually to .env.development.local"
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
        sed -i.bak '/^# KILTER_SYNC_TOKEN=/d' .env.development.local
        echo "KILTER_SYNC_TOKEN=$kilter_token" >> .env.development.local
        rm -f .env.development.local.bak
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
        sed -i.bak '/^# TENSION_SYNC_TOKEN=/d' .env.development.local
        echo "TENSION_SYNC_TOKEN=$tension_token" >> .env.development.local
        rm -f .env.development.local.bak
    else
        print_warning "Failed to get Tension token - you can add it manually later"
    fi
    
    echo ""
    print_success "Aurora API tokens setup complete"
    echo "Tokens have been added to your .env.development.local file"
else
    echo ""
    print_warning "Skipping Aurora API tokens setup"
    echo "You can add them manually later to .env.development.local:"
    echo "  KILTER_SYNC_TOKEN=your_kilter_token"
    echo "  TENSION_SYNC_TOKEN=your_tension_token"
fi

print_step "Step 5: Setting Up Database"

# Check if database is already set up
if docker exec db-postgres-1 psql postgresql://postgres:password@localhost:5432/verceldb -c "SELECT 1 FROM board_climbs LIMIT 1;" >/dev/null 2>&1; then
    print_success "Database is already set up with board data"
else
    echo "Starting PostgreSQL database with Docker..."
    cd packages/web/db/
    if docker compose version >/dev/null 2>&1; then
      if ! docker compose up -d; then
          print_error "Failed to start database container"
      fi
    else
      if ! docker-compose up -d; then
          print_error "Failed to start database container"
      fi
    fi

    echo "Waiting for database to be ready..."
    sleep 5

    echo "Setting up database schema and loading board data..."
    echo "This may take a few minutes as we download and process board databases..."

    cd ..
    print_success "Database setup completed"
fi

echo ""
echo -e "${GREEN}${ROCKET} Setup Complete! ${ROCKET}${NC}"
echo ""
echo "You can now start developing:"
echo ""
echo -e "${BLUE}Start the development server:${NC}"
echo "  bun run dev"
echo ""
echo -e "${BLUE}View your database:${NC}"
echo "  bunx drizzle-kit studio"
echo ""
echo -e "${BLUE}Format code:${NC}"
echo "  bun run format"
echo ""
echo -e "${BLUE}Need help?${NC}"
echo "  Check CLAUDE.md for development guidelines"
echo "  Visit http://localhost:3000 once dev server is running"
echo ""
echo -e "${GREEN}Happy coding! ${CHECK}${NC}"