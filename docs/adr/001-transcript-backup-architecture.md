# ADR-001: Transcript Backup Architecture

- **Status:** Accepted
- **Date:** 2026-02-03
- **Decision-makers:** @vhscom

## Context and Problem Statement

Moltworker persists agent state to R2 for durability across container restarts. Session transcripts (`*.jsonl` files) require special handling because they:

1. Grow indefinitely (append-only conversation logs)
2. Contain user data subject to GDPR rights (erasure, portability, access)
3. Are rarely accessed after the session ends
4. Should not be deleted when config is reset or migrated

How should we structure transcript backups to enable compliance interventions and cost optimization?

## Decision Drivers

- **GDPR Article 17** (Right to Erasure): Must be able to delete all data for a specific user/agent
- **GDPR Article 20** (Right to Portability): Must be able to export all data for a specific user/agent
- **Cost efficiency**: Transcripts are write-once, read-rarely after session completion
- **Operational simplicity**: Avoid complex backup/restore logic
- **Data integrity**: Transcripts must never be accidentally deleted during sync

## Considered Options

### Option A: Mixed Storage (transcripts inside config backup)

```
R2/config/
├── clawdbot.json
├── agents/
│   └── {agentId}/
│       └── sessions/
│           └── *.jsonl    # Transcripts mixed with config
```

**Pros:**
- Simple implementation (single rsync command)
- Mirrors source directory structure exactly

**Cons:**
- `--delete` flag would remove transcripts if source is reset
- Cannot apply different lifecycle rules to transcripts
- GDPR deletion requires parsing the config backup
- No path to IA storage without moving entire config

### Option B: Separate Prefix with Preserved Paths

```
R2/config/          # Mutable config (--delete enabled)
R2/transcripts/     # Append-only transcripts (no --delete)
    └── agents/
        └── {agentId}/
            └── sessions/
                └── *.jsonl
R2/memory/          # Memory files only (no --delete for files, --delete for skills)
    ├── MEMORY.md
    ├── USER.md
    ├── SOUL.md
    ├── IDENTITY.md
    ├── TOOLS.md
    ├── memory/
    │   └── *.md
    └── skills/     # --delete enabled (mirrors local state)
```

**Pros:**
- Transcripts survive config resets (no `--delete`)
- Single lifecycle rule transitions all transcripts to IA
- GDPR interventions target `transcripts/agents/{agentId}/` prefix
- Clear separation of mutable vs append-only data

**Cons:**
- Two rsync commands instead of one
- Restore logic must merge transcripts back into config directory
- Slightly more complex implementation

### Option C: External Transcript Service

Store transcripts in a dedicated system (e.g., ClickHouse, S3 with Athena).

**Pros:**
- Purpose-built for time-series/log data
- Rich query capabilities

**Cons:**
- Additional infrastructure to manage
- Increased complexity and cost
- Overkill for single-agent deployment

## Decision Outcome

**Chosen option: Option B (Separate Prefix with Preserved Paths)**

The implementation uses rsync's `--relative` flag with a path marker (`./`) to preserve directory structure:

```bash
# Config: mutable, --delete enabled
rsync -r --no-times --delete \
    --exclude='agents/*/sessions/*.jsonl' \
    /root/.clawdbot/ ${R2_MOUNT_PATH}/config/

# Transcripts: append-only, no --delete, path preserved
rsync -r --no-times --relative \
    /root/.clawdbot/./agents/*/sessions/*.jsonl \
    ${R2_MOUNT_PATH}/transcripts/ 2>/dev/null || true

# Memory files: no --delete (preserves history, orphans acceptable)
rsync -r --no-times \
    --include='MEMORY.md' --include='USER.md' --include='SOUL.md' \
    --include='IDENTITY.md' --include='TOOLS.md' \
    --include='memory/' --include='memory/*.md' \
    --exclude='*' \
    /root/clawd/ ${R2_MOUNT_PATH}/memory/

# Skills: with --delete (mirrors local state exactly)
rsync -r --no-times --delete \
    /root/clawd/skills/ ${R2_MOUNT_PATH}/memory/skills/
```

The `./` marker in the source path tells rsync to preserve everything after it, resulting in:
```
R2/transcripts/agents/{agentId}/sessions/{timestamp}.jsonl
```

### Memory-Only Persistence Rationale

Only memory files survive the molt—not the entire workspace. This reduces R2 costs and Class A operations while preserving what matters:

| Data Type | Persisted | Rationale |
|-----------|-----------|-----------|
| MEMORY.md, USER.md, SOUL.md, IDENTITY.md, TOOLS.md | Yes | Core identity and learned context |
| memory/*.md | Yes | Daily notes and accumulated knowledge |
| skills/ | Yes (with --delete) | Custom skills are config, should mirror local |
| Project files, cloned repos, build artifacts | No | Ephemeral, easily recreated, potentially GB-sized |

Memory files use no `--delete` to preserve history (orphaned files are acceptable), while skills use `--delete` to mirror local state exactly.

## Consequences

### Positive

- **GDPR erasure**: Delete user data with `rclone delete r2:bucket/transcripts/agents/{agentId}/`
- **GDPR portability**: Export with `rclone copy r2:bucket/transcripts/agents/{agentId}/ ./export/`
- **IA migration**: Single lifecycle rule on `transcripts/` prefix transitions all transcripts after N days
- **Data safety**: Config resets cannot accidentally delete conversation history
- **Cost optimization**: ~33% storage cost reduction for aged transcripts ($0.015 → $0.01/GB/month)

### Negative

- Restore requires merging transcripts back into config directory (handled in `start-moltbot.sh`)
- Two rsync operations instead of one (negligible performance impact)
- Empty glob handling required (`|| true`) for new installations

### Neutral

- Transcripts in IA storage incur retrieval fees ($0.01/GB) if accessed
- 30-day minimum storage duration for IA objects

## Implementation Notes

### R2 Lifecycle Rule for IA Transition

```json
{
  "rules": [{
    "id": "transcripts-to-ia",
    "enabled": true,
    "conditions": {
      "prefix": "transcripts/",
      "age": { "days": 30 }
    },
    "actions": {
      "transitionToInfrequentAccess": true
    }
  }]
}
```

### GDPR Intervention Scripts

```bash
# Right to Erasure (Article 17)
AGENT_ID="user-123"
rclone delete "r2:moltbot-data/transcripts/agents/${AGENT_ID}/"

# Right to Portability (Article 20)
AGENT_ID="user-123"
rclone copy "r2:moltbot-data/transcripts/agents/${AGENT_ID}/" "./export/${AGENT_ID}/"

# Right to Access (Article 15)
AGENT_ID="user-123"
rclone ls "r2:moltbot-data/transcripts/agents/${AGENT_ID}/"
```

## References

- [Cloudflare R2 Storage Classes](https://developers.cloudflare.com/r2/buckets/storage-classes/)
- [R2 Object Lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [MADR Template](https://adr.github.io/madr/)
- [OpenClaw Memory Docs](https://docs.openclaw.ai/concepts/memory)
