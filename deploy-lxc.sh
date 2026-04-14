#!/bin/bash
# ─────────────────────────────────────────────────
# SSH MCP Server - LXC Deployment Script
# Run this ON the Proxmox host (or inside the target LXC)
# ─────────────────────────────────────────────────
set -euo pipefail

# ── Configuration ───────────────────────────────
LXC_ID="${LXC_ID:-400}"
HOSTNAME="ssh-mcp"
APP_DIR="/opt/ssh-mcp-server"
PORT=3000
TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-your-server.example.com}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── Check if running inside LXC or on Proxmox ──
if [ -f /run/host-id ] || grep -q "container=lxc" /proc/1/environ 2>/dev/null; then
  MODE="lxc"
else
  MODE="host"
fi

if [ "$MODE" = "host" ]; then
  echo "======================================"
  echo " SSH MCP Server - Proxmox LXC Setup"
  echo "======================================"
  echo ""

  # Check if LXC exists
  if pct status "$LXC_ID" &>/dev/null; then
    warn "LXC $LXC_ID already exists. Entering to deploy app..."
    pct exec "$LXC_ID" -- bash -c "curl -fsSL https://raw.githubusercontent.com/DaisukeHori/ssh-mcp-server/main/deploy-lxc.sh | bash"
    exit 0
  fi

  log "Creating LXC $LXC_ID from template 300..."

  # Clone from template
  pct clone 300 "$LXC_ID" \
    --hostname "$HOSTNAME" \
    --description "SSH MCP Server for Claude.ai" \
    --memory 512 \
    --cores 1 \
    --storage local-lvm

  # Network (DHCP or static - adjust as needed)
  pct set "$LXC_ID" -net0 name=eth0,bridge=vmbr0,ip=dhcp

  # Start
  pct start "$LXC_ID"
  sleep 5

  log "LXC $LXC_ID created and started."
  log "Deploying app inside LXC..."

  # Copy this script into LXC and run
  pct push "$LXC_ID" "$0" /tmp/deploy.sh --perms 755
  pct exec "$LXC_ID" -- bash /tmp/deploy.sh

  log "Deployment complete!"
  echo ""
  echo "  LXC ID:    $LXC_ID"
  echo "  Health:    http://$(pct exec $LXC_ID -- hostname -I | tr -d ' '):$PORT/health"
  echo ""
  echo "Next steps:"
  echo "  1. Set AUTH_TOKEN in /opt/ssh-mcp-server/.env"
  echo "  2. Configure Cloudflare Tunnel to route $TUNNEL_HOSTNAME -> http://localhost:$PORT"
  echo "  3. Add connector in Claude.ai: https://$TUNNEL_HOSTNAME/mcp"
  exit 0
fi

# ── Running inside LXC ──────────────────────────
echo "======================================"
echo " Installing SSH MCP Server in LXC"
echo "======================================"

# Install Node.js 22
if ! command -v node &>/dev/null; then
  log "Installing Node.js 22..."
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

log "Node.js $(node --version)"

# Clone or update repo
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing installation..."
  cd "$APP_DIR"
  git pull
else
  log "Cloning repository..."
  apt-get install -y -qq git
  git clone https://github.com/DaisukeHori/ssh-mcp-server.git "$APP_DIR"
  cd "$APP_DIR"
fi

# Install deps and build
log "Installing dependencies..."
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
npm install -D typescript @types/node @types/express @types/ssh2
log "Building..."
npx tsc

# Create .env if not exists
if [ ! -f "$APP_DIR/.env" ]; then
  AUTH_TOKEN=$(openssl rand -hex 32)
  cat > "$APP_DIR/.env" << EOF
PORT=$PORT
AUTH_TOKEN=$AUTH_TOKEN
REQUIRE_AUTH=true
EOF
  log "Generated AUTH_TOKEN: $AUTH_TOKEN"
  warn "Save this token! You'll need it for Cloudflare Tunnel headers or Claude.ai connector."
fi

# Create systemd service
cat > /etc/systemd/system/ssh-mcp-server.service << 'EOF'
[Unit]
Description=SSH MCP Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ssh-mcp-server
EnvironmentFile=/opt/ssh-mcp-server/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ssh-mcp-server
systemctl restart ssh-mcp-server

sleep 2

if systemctl is-active --quiet ssh-mcp-server; then
  log "ssh-mcp-server is running!"
  # Quick health check
  HEALTH=$(curl -s http://localhost:$PORT/health 2>/dev/null || echo "failed")
  log "Health: $HEALTH"
else
  err "ssh-mcp-server failed to start. Check: journalctl -u ssh-mcp-server -n 20"
fi

echo ""
echo "======================================"
echo " Deployment Complete!"
echo "======================================"
echo ""
echo " Service: systemctl status ssh-mcp-server"
echo " Logs:    journalctl -u ssh-mcp-server -f"
echo " Config:  $APP_DIR/.env"
echo ""
