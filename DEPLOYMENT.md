# Deployment — mcp-nanobanana

| Field | Value |
|---|---|
| **URL** | https://nanobanana.mcp.pathfindermarketing.com.au/mcp |
| **Droplet service** | `nanobanana` (in `/opt/pmin-mcpinfrastructure/docker-compose.yml`) |
| **Internal port** | 8080 (Node OAuth proxy) → 127.0.0.1:8081 (Python FastMCP) |
| **Volume** | `./data/nanobanana-images` → `/data/images` (`IMAGE_OUTPUT_DIR`) |
| **Env file** | `/opt/pmin-mcpinfrastructure/env/nanobanana.env` |
| **1P item** | `Claude_Connector - Gemini (Nano Banana)` (vault: `Claude Code`) |
| **Runbook** | `/opt/pmin-mcpinfrastructure/docs/runbooks/nanobanana.md` |

## Rebuild / redeploy

```bash
# Push your changes to origin first, then:
ssh mcp-server "cd /opt/pmin-mcpinfrastructure/repos/mcp-nanobanana && git pull --ff-only && cd /opt/pmin-mcpinfrastructure && bash scripts/check-repos-sync.sh nanobanana && docker compose build nanobanana && docker compose up -d nanobanana"
```

## Post-deploy verification

```bash
# Health (public, no auth)
curl -s https://nanobanana.mcp.pathfindermarketing.com.au/health

# OAuth discovery
curl -s https://nanobanana.mcp.pathfindermarketing.com.au/.well-known/oauth-authorization-server

# Bearer enforcement (expect 401 without token)
curl -so /dev/null -w "%{http_code}\n" -X POST https://nanobanana.mcp.pathfindermarketing.com.au/mcp -H "Content-Type: application/json" -d '{}'

# Session-persistence regression (expect PASS on all 3 stateful assertions)
MCP_TOKEN=$(op read "op://Claude Code/g4ryqq22gzdya7gdo5y74gmr2y/MCP Auth Token")
ssh mcp-server "cd /opt/pmin-mcpinfrastructure/repos/mcp-nanobanana && node scripts/test-session-persistence.js https://nanobanana.mcp.pathfindermarketing.com.au $MCP_TOKEN"
```

## Pair to claude.ai

Go to **claude.ai → Settings → Integrations → Add custom integration**:

| Field | Value |
|---|---|
| **Name** | NanoBanana |
| **Remote MCP Server URL** | https://nanobanana.mcp.pathfindermarketing.com.au/mcp |
| **Client ID** | claude-pathfinder |
| **Client Secret** | (1P: `Claude_Connector - Gemini (Nano Banana)` → `OAuth Client Secret`) |

Complete the PKCE flow in the browser window that opens.
