# Board Controller

A Python WebSocket server that enables persistent queue management and collaborative control for Kilter/Tension climbing boards. Integrates with Boardsesh.com to provide synchronized queue state across multiple devices and apps.

## Features

- **Single Entry Point**: One command starts everything
- **Bluetooth Support**: Accepts commands from Kilter/Tension mobile apps (optional)
- **WebSocket Integration**: Real-time synchronization with Boardsesh.com
- **Queue Persistence**: SQLite database maintains queue state across restarts
- **Auto-redirect**: localhost:8000 automatically redirects to Boardsesh with controller integration
- **Multi-device Support**: Control queue from both web browser and mobile apps simultaneously

## Quick Start

### Prerequisites

- Python 3.10+ (the Docker image uses Python 3.11)
- Bluetooth adapter (optional, for Bluetooth functionality)

The pinned `python-multipart` and `python-dotenv` releases require Python 3.10 or newer.
`cryptography` 50 also drops the previously documented Python 3.8 support.

### Installation

```bash
# Install the checked-in dependency pins
python -m pip install -r requirements.txt
```

### Usage

```bash
# Start the controller (with Bluetooth)
python main.py

# Start without Bluetooth (web-only mode)
python main.py --no-bluetooth

# Use custom port
python main.py --port 8080
```

### First Connection

1. Run `python main.py`
2. Open http://localhost:8000 in your browser
3. You'll be automatically redirected to Boardsesh with controller integration
4. The controller takes over queue management from Boardsesh
5. Add climbs to the queue - they persist across browser refreshes
6. Use both Boardsesh web interface and Kilter/Tension mobile apps

## Architecture

### Components

- **main.py**: Unified FastAPI server with WebSocket support
- **controller.py**: Original Bluetooth controller integration (optional)
- **board_controller.db**: SQLite database for queue persistence (auto-created)

### API Endpoints

- `GET /api/session` - Get session info
- `GET /api/queue` - Get current queue
- `POST /api/queue/add` - Add climb to queue
- `DELETE /api/queue/{uuid}` - Remove climb from queue
- `POST /api/queue/current/{uuid}` - Set current climb
- `WS /ws` - WebSocket for real-time updates

### WebSocket Protocol

Key message types between Boardsesh and controller:

```json
// Initial handshake from controller
{
  "type": "controller-handshake",
  "sessionId": "uuid",
  "controllerId": "uuid",
  "capabilities": ["queue", "bluetooth", "persistence"]
}

// New connection request (triggers queue data response)
{
  "type": "new-connection",
  "source": "boardsesh-client"
}

// Queue state update
{
  "type": "initial-queue-data",
  "queue": [...],
  "currentClimbQueueItem": {...}
}

// Queue operations
{
  "type": "add-queue-item",
  "item": { "climb": {...}, "addedBy": "user", "uuid": "..." }
}

{
  "type": "update-current-climb",
  "item": {...},
  "shouldAddToQueue": false
}
```

## Development

The server uses FastAPI with automatic reload:

```bash
# Run with auto-reload for development
python main.py --no-bluetooth

# Or use uvicorn directly
uvicorn main:BoardController().app --reload --port 8000
```

### Database

SQLite database is created automatically with tables:

- `sessions` - Controller sessions
- `queue_items` - Queue persistence
- `climb_cache` - Boardsesh API cache

## Configuration

### Environment Variables

- `LOG_LEVEL` - Logging level (default: INFO)
- `DB_PATH` - Database file path (default: ./board_controller.db)
- `CACHE_TTL_HOURS` - API cache TTL (default: 24)

#### Board Configuration

These environment variables control the default board configuration for the redirect URL when accessing the controller root endpoint:

- `BOARD_NAME` - Board type: `kilter` or `tension` (default: kilter)
- `BOARD_LAYOUT` - Board layout name (varies by board, default: original)
- `BOARD_SIZE` - Board size (varies by board, default: 12x12)
- `BOARD_SET` - Holds set (varies by board, default: screw_bolt)
- `BOARD_ANGLE` - Board angle: 0-70 in 5-degree increments (default: 40)

**How to Find Your Board Configuration:**

The easiest way to determine your board's configuration is to look at your Boardsesh URL when you navigate to your specific board setup. The URL follows this pattern:

```
https://www.boardsesh.com/{board_name}/{layout}/{size}/{set}/{angle}/list
```

For example:

- `https://www.boardsesh.com/kilter/original/12x12/screw_bolt/40/list`
- `https://www.boardsesh.com/tension/1/8x12/TB2-plastic/30/list`

**Available Options by Board:**

**Kilter Board:**

- **Board Name**: `kilter`
- **Layouts**: URL-friendly layout names:
  - `original` (most common layout)
- **Sizes**: Board dimensions as URL slugs:
  - `12x12`, `8x10`, `16x12` (standard board sizes)
- **Sets**: Hold set names as URL slugs:
  - `bolt`, `screw` (individual hold types)
  - `screw_bolt` (both hold types combined, sorted alphabetically descending)
- **Angles**: `0`, `5`, `10`, `15`, `20`, `25`, `30`, `35`, `40`, `45`, `50`, `55`, `60`, `65`, `70`

**Tension Board:**

- **Board Name**: `tension`
- **Layouts**: URL-friendly layout names:
  - `1`, `2`, `3`, ..., `28` (for numbered layouts)
  - `two-mirror`, `two-spray` (for layouts that start with "2-" in database)
- **Sizes**: Board dimensions as URL slugs:
  - `8x10`, `8x12`, `12x10`, `12x12`
- **Sets**: Hold set names as URL slugs:
  - `plastic`, `wood` (individual hold types)
  - `plastic_wood` (both hold types combined)
- **Angles**: `0`, `5`, `10`, `15`, `20`, `25`, `30`, `35`, `40`, `45`, `50`, `55`, `60`, `65`, `70`

**Note**: The exact available options depend on your specific board configuration and what hold sets you have installed. Visit Boardsesh.com and navigate to your board to see the exact URL parameters for your setup.

**Example configurations:**

```bash
# Kilter 12x12 with screw and bolt holds at 45 degrees
BOARD_NAME=kilter
BOARD_LAYOUT=original
BOARD_SIZE=12x12
BOARD_SET=screw_bolt
BOARD_ANGLE=45

# Tension 8x12 with plastic holds at 30 degrees
BOARD_NAME=tension
BOARD_LAYOUT=two-mirror
BOARD_SIZE=8x12
BOARD_SET=plastic
BOARD_ANGLE=30
```

### Command Line Options

```bash
python main.py --help
```

Options:

- `--no-bluetooth` - Disable Bluetooth support
- `--port PORT` - Server port (default: 8000)
- `--host HOST` - Server host (default: 0.0.0.0)
- `--ssl-cert FILE` - SSL certificate file for HTTPS/WSS
- `--ssl-key FILE` - SSL private key file for HTTPS/WSS

### SSL Setup (HTTPS/WSS Support)

When accessing the controller from HTTPS sites like boardsesh.com, you need SSL support:

**Generate development certificates:**

```bash
# Install cryptography library
pip install cryptography

# Generate self-signed certificate
python generate_cert.py --ip 192.168.1.112

# Start server with SSL
python main.py --ssl-cert server.crt --ssl-key server.key
```

**Production certificates:**

```bash
# Use Let's Encrypt or other CA
certbot certonly --standalone -d your-domain.com

# Start with real certificates
python main.py --ssl-cert /etc/letsencrypt/live/your-domain.com/fullchain.pem \
               --ssl-key /etc/letsencrypt/live/your-domain.com/privkey.pem
```

The server automatically detects SSL and uses WSS for WebSocket connections.

## Troubleshooting

### Bluetooth Issues

1. Ensure Bluetooth adapter is available:

   ```bash
   bluetoothctl show
   ```

2. Check if running with proper permissions:

   ```bash
   sudo python main.py
   ```

3. For Raspberry Pi, ensure BlueZ is installed:
   ```bash
   sudo apt install bluez python3-dbus
   ```

### WebSocket Connection Issues

1. Check firewall settings
2. Ensure port 8000 is accessible
3. For HTTPS sites, controller needs HTTPS/WSS too (see SSL Setup below)

### Database Issues

1. Check write permissions in controller directory
2. Delete `board_controller.db` to reset
3. Check disk space

## Deployment

### Raspberry Pi

```bash
# Install system dependencies
sudo apt update
sudo apt install python3-pip python3-venv

# Optional: for Bluetooth support
sudo apt install bluez python3-dbus

# Clone and setup
git clone <repo>
cd board-controller
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn aiosqlite

# Run
python main.py

# Run as service (create systemd service file)
sudo tee /etc/systemd/system/board-controller.service > /dev/null <<EOF
[Unit]
Description=Board Controller
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/board-controller
Environment=PATH=/home/pi/board-controller/venv/bin
ExecStart=/home/pi/board-controller/venv/bin/python main.py
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable board-controller
sudo systemctl start board-controller
```

### Docker

**Option 1: Docker Compose (Recommended)**

```bash
# Run with persistent database
docker-compose up -d

# Run web-only mode (no Bluetooth)
docker-compose --profile web-only up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

**Option 2: Docker Run**

```bash
# Build image
docker build -t board-controller .

# Run container (basic)
docker run -p 8000:8000 board-controller

# Run with Bluetooth support (Linux only)
docker run -p 8000:8000 --privileged --net=host board-controller

# Run with persistent database
docker run -p 8000:8000 -v ./data:/app/data board-controller

# Run web-only mode
docker run -p 8000:8000 -v ./data:/app/data board-controller \
  python main.py --no-bluetooth --host 0.0.0.0
```

## Integration with Boardsesh

The controller is designed to seamlessly integrate with Boardsesh.com:

1. **Detection**: Boardsesh detects `controllerUrl` parameter in URL
2. **Connection**: Establishes WebSocket connection to controller
3. **Takeover**: Controller becomes the source of truth for queue state
4. **Synchronization**: All queue changes sync through controller
5. **Fallback**: If controller disconnects, Boardsesh falls back to PeerJS

This allows users to control their climbing board through:

- Boardsesh web interface
- Kilter/Tension mobile apps
- Controller web interface

All interfaces stay synchronized through the controller's queue management.

## Publishing & Distribution

### Container Registry

The Docker image is automatically built and published to GitHub Container Registry:

**Pull and run the latest version:**

```bash
# Pull latest image
docker pull ghcr.io/boardsesh/boardsesh-board-controller:latest

# Run with Docker
docker run -p 8000:8000 -v ./data:/app/data ghcr.io/boardsesh/boardsesh-board-controller:latest

# Or use docker-compose (recommended)
curl -O https://raw.githubusercontent.com/marcodejongh/boardsesh/main/board-controller/docker-compose.yml
docker-compose up -d
```

**Available tags:**

- `latest` - Latest stable build from main branch
- `main` - Latest build from main branch
- `v1.0.0` - Specific version releases
- `pr-123` - Pull request builds for testing

### GitHub Releases

Create releases with pre-built assets:

```bash
# Create release with binaries for different platforms
# Include installation scripts for Raspberry Pi
# Package Docker compose files
```

### Package Managers

Consider publishing to:

- **PyPI**: `pip install board-controller`
- **Homebrew**: `brew install board-controller`
- **APT repository**: For Debian/Ubuntu users

### One-Line Install Script

Create an install script for easy setup:

```bash
# Install script example
curl -fsSL https://raw.githubusercontent.com/user/repo/main/install.sh | bash
```

This would handle:

1. Platform detection (Raspberry Pi, Linux, macOS)
2. Dependency installation
3. Service setup
4. Configuration prompts
