# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
npm run dev           # Vite dev server for React admin UI
npm run start         # wrangler dev (local worker runtime)
npm run build         # Build worker + client (Vite bundler)
npm run typecheck     # TypeScript type checking
```

### Testing
```bash
npm test              # Run tests (vitest)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

**Note:** To run a single test file, use `npx vitest run <path>` (e.g., `npx vitest run src/auth/jwt.test.ts`)

### Deployment
```bash
npm run deploy        # Build and deploy to Cloudflare
npx wrangler tail     # View live logs
npx wrangler secret list           # List configured secrets
npx wrangler secret put SECRET_NAME  # Set a secret
```

## Architecture Overview

This is a Cloudflare Worker that runs OpenClaw (formerly Moltbot) in a Cloudflare Sandbox container. The Worker proxies requests to the OpenClaw gateway running inside the container.

### Request Flow

```
Browser/Client
    ↓
Cloudflare Worker (src/index.ts)
    ↓ (proxies HTTP/WebSocket)
Sandbox Container (Dockerfile)
    ↓
OpenClaw Gateway (port 18789)
```

### Key Architectural Patterns

**1. Middleware Pipeline (src/index.ts)**
- Public routes (health checks, static assets) bypass authentication
- Protected routes use Cloudflare Access JWT validation (`src/auth/middleware.ts`)
- All routes get a `sandbox` variable injected into Hono context

**2. Container Lifecycle**
- `SANDBOX_SLEEP_AFTER` controls when container sleeps (`never` = always on, `10m` = sleep after 10 min)
- Cold starts take 1-2 minutes due to container initialization
- Gateway process is found/started via `ensureMoltbotGateway()` in `src/gateway/process.ts`

**3. R2 Storage Pattern (Backup/Restore)**
- **Startup** (`start-moltbot.sh`): Restore from R2 if backup is newer than local data
- **Runtime** (Worker cron): Sync local data to R2 every 5 minutes
- **Admin UI**: Manual "Backup Now" button triggers immediate sync
- Mount point: `/data/moltbot` inside container

**4. Environment Variable Mapping**
- Worker env vars → Container env vars via `buildEnvVars()` in `src/gateway/env.ts`
- Example: `DEV_MODE` → `CLAWDBOT_DEV_MODE`, `MOLTBOT_GATEWAY_TOKEN` → `CLAWDBOT_GATEWAY_TOKEN`
- Container startup script (`start-moltbot.sh`) reads env vars and updates `~/.clawdbot/clawdbot.json`

**5. CLI Command Pattern**
The OpenClaw CLI is still named `clawdbot` internally (upstream hasn't renamed yet). When calling CLI commands from the Worker:
- Always include `--url ws://localhost:18789`
- Commands take 10-15 seconds due to WebSocket connection overhead
- Use `waitForProcess()` helper in `src/gateway/utils.ts`
- Success detection: case-insensitive check for `stdout.toLowerCase().includes('approved')`

Example:
```typescript
const proc = sandbox.startProcess('clawdbot devices list --json --url ws://localhost:18789')
const result = await waitForProcess(proc, 15000)
```

### Route Organization

| Route Pattern | Handler | Purpose | Auth |
|--------------|---------|---------|------|
| `/` (catch-all) | src/index.ts | Proxy to gateway | CF Access |
| `/_admin/*` | src/routes/admin-ui.ts | Static files for admin UI | CF Access |
| `/api/*` | src/routes/api.ts | Device pairing, gateway control | CF Access |
| `/debug/*` | src/routes/debug.ts | Process/log inspection | CF Access + `DEBUG_ROUTES=true` |
| `/cdp/*` | src/routes/cdp.ts | Browser automation shim | CDP_SECRET header |
| `/sandbox-health` | src/routes/public.ts | Health check | Public |

### Auth Layers

1. **Cloudflare Access** (`src/auth/middleware.ts`): JWT validation for admin routes
2. **Gateway Token**: Required query param (`?token=...`) to access Control UI
3. **Device Pairing**: Each device must be approved via admin UI (unless `DEV_MODE=true`)

## Key Gotchas

### CLI Naming
The CLI is still named `clawdbot` until upstream renames it. Config paths use `~/.clawdbot/` internally.

### R2 Storage
- **Never delete R2 data**: `/data/moltbot` IS the R2 bucket when mounted
- **rsync compatibility**: Use `rsync -r --no-times` (not `-a`). s3fs doesn't support setting timestamps.
- **Mount detection**: Check `mount | grep s3fs`, don't rely on `sandbox.mountBucket()` error messages
- **Process status**: Don't rely on `proc.status` for completion. Verify output instead (e.g., check for timestamp file).

### WebSocket Development
`wrangler dev` has issues proxying WebSocket connections through the sandbox. HTTP works, but WebSocket may fail locally. Deploy to Cloudflare for full functionality.

### Docker Image Caching
When changing `moltbot.json.template` or `start-moltbot.sh`, bump the cache bust comment in Dockerfile:
```dockerfile
# Build cache bust: 2026-01-26-v10
```

### Config Validation
OpenClaw has strict config validation:
- `agents.defaults.model` must be `{ "primary": "model/name" }` not a string
- `gateway.mode` must be `"local"` for headless operation
- No `webchat` channel - Control UI is served automatically
- `gateway.bind` is a CLI flag, not a config option

## Source Code Structure

```
src/
├── index.ts          # Main Hono app, middleware, catch-all proxy
├── types.ts          # MoltbotEnv, AppEnv, JWTPayload interfaces
├── config.ts         # Constants (MOLTBOT_PORT, R2_MOUNT_PATH, etc.)
├── auth/             # Cloudflare Access JWT authentication
│   ├── jwt.ts        # JWT decoding/validation
│   ├── jwks.ts       # JWKS fetching + caching
│   └── middleware.ts # Hono middleware for CF Access
├── gateway/          # OpenClaw gateway process management
│   ├── process.ts    # Find/start gateway process
│   ├── env.ts        # Build container env vars
│   ├── r2.ts         # R2 bucket mounting
│   ├── sync.ts       # Backup sync logic
│   └── utils.ts      # waitForProcess() helper
├── routes/           # Route handlers
│   ├── public.ts     # Health checks, logo assets
│   ├── admin-ui.ts   # React app static file serving
│   ├── api.ts        # /api/* endpoints (devices, gateway, R2)
│   ├── debug.ts      # /debug/* process inspection
│   └── cdp.ts        # /cdp/* browser automation
└── client/           # React admin UI (Vite)
    ├── App.tsx       # Main React app
    ├── api.ts        # Fetch client for /api/*
    └── pages/        # Device pairing, R2 status UI
```

## Container Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Based on `cloudflare/sandbox:0.7.0` with Node 22 + OpenClaw |
| `start-moltbot.sh` | Startup script: restore from R2, configure from env vars, start gateway |
| `moltbot.json.template` | Default OpenClaw config template |
| `skills/` | Custom skills copied into container at `/root/clawd/skills/` |

## Local Development

Create `.dev.vars`:
```bash
ANTHROPIC_API_KEY=sk-ant-...
DEV_MODE=true           # Skips CF Access + device pairing
DEBUG_ROUTES=true       # Enables /debug/* routes
```

Run:
```bash
npm install
npm run start
```

**Note:** WebSocket connections may not work in local dev. Deploy for full testing.

## Environment Variables

See `src/types.ts` for the full `MoltbotEnv` interface.

**Required (production):**
- `ANTHROPIC_API_KEY` or (`AI_GATEWAY_API_KEY` + `AI_GATEWAY_BASE_URL`)
- `MOLTBOT_GATEWAY_TOKEN` - Gateway access token
- `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` - Cloudflare Access JWT validation

**Optional:**
- `DEV_MODE=true` - Local dev only (skips auth + pairing)
- `DEBUG_ROUTES=true` - Enables /debug/* routes
- `SANDBOX_SLEEP_AFTER` - Container sleep timeout (`never` or `10m`, `1h`, etc.)
- `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` + `CF_ACCOUNT_ID` - R2 persistence
- Chat platform tokens: `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, etc.
- `CDP_SECRET` + `WORKER_URL` - Browser automation via /cdp

## Testing Patterns

Tests use Vitest with colocated test files (`*.test.ts`).

**Current coverage:**
- `auth/` - JWT decoding, JWKS caching, middleware behavior
- `gateway/` - Env var building, process finding, R2 mounting, sync logic

**When adding new functionality:**
1. Add test file next to source file (e.g., `foo.ts` → `foo.test.ts`)
2. Use `describe()` for grouping, `it()` for test cases
3. Mock Cloudflare bindings as needed (see existing tests for examples)
