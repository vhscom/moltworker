import type { Sandbox } from "@cloudflare/sandbox";
import { R2_MOUNT_PATH } from "../config";
import type { MoltbotEnv } from "../types";
import { mountR2Storage } from "./r2";
import { waitForProcess } from "./utils";

export interface SyncResult {
	success: boolean;
	lastSync?: string;
	error?: string;
	details?: string;
}

/**
 * Sync moltbot config from container to R2 for persistence.
 * Patterns to exclude from config backup (/root/.clawdbot/ -> R2/config/)
 * Note: Session transcripts (*.jsonl) are backed up separately to R2/transcripts/
 */
const CONFIG_EXCLUSIONS = [
	// Ephemeral workspaces - not persisted, won't survive restart
	// (we use explicit workspace at /root/clawd/ instead)
	"workspace", // sandbox mode without profile
	"workspace-*", // sandbox mode with profile
	// Temp files
	"*.lock",
	"*.log",
	"*.tmp",
];

/** Convert exclusion list to rsync --exclude flags */
function toRsyncExcludes(patterns: string[]): string {
	return patterns.map((p) => `--exclude='${p}'`).join(" ");
}

/**
 * Memory files that survive the molt.
 * These are the only files backed up from the workspace to R2.
 * Everything else in /root/clawd/ is ephemeral and will not persist.
 */
const MEMORY_INCLUDES = [
	"MEMORY.md",
	"USER.md",
	"SOUL.md",
	"IDENTITY.md",
	"TOOLS.md",
	"memory/",
	"memory/*.md",
];

/** Convert include list to rsync --include flags */
function toRsyncIncludes(patterns: string[]): string {
	return patterns.map((p) => `--include='${p}'`).join(" ");
}

/**
 * Sync moltbot config from container to R2 for persistence.
 *
 * Backup structure (semantic names to survive upstream renames):
 * - R2/config/ - Config from /root/.clawdbot/ (excluding transcripts)
 * - R2/transcripts/agents/[name]/sessions/*.jsonl - Session transcripts (path preserved)
 * - R2/memory/ - Memory files only from /root/clawd/ (not entire workspace)
 *
 * Memory files that survive the molt:
 * - Core: MEMORY.md, USER.md, SOUL.md, IDENTITY.md, TOOLS.md
 * - Daily notes: memory/*.md
 * - Custom skills: skills/ (synced with --delete to mirror local state)
 *
 * The rest of /root/clawd/ is ephemeral (project files, build artifacts, etc.)
 * and will not persist across container restarts.
 *
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config and memory files to R2
 * 4. Writes a timestamp file for tracking
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns SyncResult with success status and optional error details
 */
export async function syncToR2(
	sandbox: Sandbox,
	env: MoltbotEnv,
): Promise<SyncResult> {
	// Check if R2 is configured
	if (
		!env.R2_ACCESS_KEY_ID ||
		!env.R2_SECRET_ACCESS_KEY ||
		!env.CF_ACCOUNT_ID
	) {
		return { success: false, error: "R2 storage is not configured" };
	}

	// Mount R2 if not already mounted
	const mounted = await mountR2Storage(sandbox, env);
	if (!mounted) {
		return { success: false, error: "Failed to mount R2 storage" };
	}

	// Sanity check: verify source has critical files before syncing
	// This prevents accidentally overwriting a good backup with empty/corrupted data
	try {
		const checkProc = await sandbox.startProcess(
			'test -f /root/.clawdbot/clawdbot.json && echo "ok"',
		);
		await waitForProcess(checkProc, 5000);
		const checkLogs = await checkProc.getLogs();
		if (!checkLogs.stdout?.includes("ok")) {
			return {
				success: false,
				error: "Sync aborted: source missing clawdbot.json",
				details:
					"The local config directory is missing critical files. This could indicate corruption or an incomplete setup.",
			};
		}
	} catch (err) {
		return {
			success: false,
			error: "Failed to verify source files",
			details: err instanceof Error ? err.message : "Unknown error",
		};
	}

	// Run rsync to backup config to R2
	// [downstream] Also backs up memory files and transcripts (not entire workspace)
	// Note: Use --no-times because s3fs doesn't support setting timestamps
	const configExcludes = toRsyncExcludes(CONFIG_EXCLUSIONS);
	const memoryIncludes = toRsyncIncludes(MEMORY_INCLUDES);
	const syncCmd = [
		// Config: full sync with delete (mutable state)
		`rsync -r --no-times --delete ${configExcludes} --exclude='agents/*/sessions/*.jsonl' /root/.clawdbot/ ${R2_MOUNT_PATH}/config/`,
		// Transcripts: append-only, no delete, preserve path structure (--relative with ./ marker)
		// Note: || true handles empty glob (no sessions yet) gracefully
		`rsync -r --no-times --relative /root/.clawdbot/./agents/*/sessions/*.jsonl ${R2_MOUNT_PATH}/transcripts/ 2>/dev/null || true`,
		// Memory files: no --delete (preserves history, orphans acceptable)
		// Only syncs specific memory files, not entire workspace
		`rsync -r --no-times ${memoryIncludes} --exclude='*' /root/clawd/ ${R2_MOUNT_PATH}/memory/`,
		// Skills: with --delete (mirrors local state exactly)
		`rsync -r --no-times --delete /root/clawd/skills/ ${R2_MOUNT_PATH}/memory/skills/`,
		// Timestamp
		`date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`,
	].join(" && ");

	try {
		const proc = await sandbox.startProcess(syncCmd);
		await waitForProcess(proc, 30000); // 30 second timeout for sync

		// Check for success by reading the timestamp file
		// (process status may not update reliably in sandbox API)
		// Note: backup structure is ${R2_MOUNT_PATH}/clawdbot/ and ${R2_MOUNT_PATH}/skills/
		// [downstream] Semantic paths: config/, memory/, transcripts/
		const timestampProc = await sandbox.startProcess(
			`cat ${R2_MOUNT_PATH}/.last-sync`,
		);
		await waitForProcess(timestampProc, 5000);
		const timestampLogs = await timestampProc.getLogs();
		const lastSync = timestampLogs.stdout?.trim();

		if (lastSync?.match(/^\d{4}-\d{2}-\d{2}/)) {
			return { success: true, lastSync };
		} else {
			const logs = await proc.getLogs();
			return {
				success: false,
				error: "Sync failed",
				details: logs.stderr || logs.stdout || "No timestamp file created",
			};
		}
	} catch (err) {
		return {
			success: false,
			error: "Sync error",
			details: err instanceof Error ? err.message : "Unknown error",
		};
	}
}
