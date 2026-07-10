import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import type { AgentWorkspace } from "@better-ccflare/types";

const log = new Logger("WorkspacePersistence");

const WORKSPACES_FILE = join(homedir(), ".better-ccflare", "workspaces.json");
const LEGACY_WORKSPACES_FILE = join(homedir(), ".ccflare", "workspaces.json");

interface WorkspacesData {
	version: number;
	workspaces: AgentWorkspace[];
}

export class WorkspacePersistence {
	private migrationChecked = false;
	private readonly workspacesFile: string;
	private readonly legacyWorkspacesFile: string;

	/**
	 * @param options.workspacesFile Override for the persisted-workspaces
	 *   file path. Defaults to the real `~/.better-ccflare/workspaces.json`.
	 *   Tests MUST pass a tmp-dir path here (or via
	 *   `AgentRegistry.setWorkspacePersistenceForTests`) instead of relying
	 *   on the default — the default writes to the real file.
	 * @param options.legacyWorkspacesFile Override for the legacy migration
	 *   source path. Defaults to the real `~/.ccflare/workspaces.json`.
	 */
	constructor(options?: {
		workspacesFile?: string;
		legacyWorkspacesFile?: string;
	}) {
		this.workspacesFile = options?.workspacesFile ?? WORKSPACES_FILE;
		this.legacyWorkspacesFile =
			options?.legacyWorkspacesFile ?? LEGACY_WORKSPACES_FILE;
	}

	private async migrateFromLegacy(): Promise<void> {
		if (this.migrationChecked) return;
		this.migrationChecked = true;

		// If new file exists, no migration needed
		if (existsSync(this.workspacesFile)) {
			return;
		}

		// If legacy file doesn't exist, nothing to migrate
		if (!existsSync(this.legacyWorkspacesFile)) {
			return;
		}

		try {
			// Ensure target directory exists
			const targetDir = dirname(this.workspacesFile);
			if (!existsSync(targetDir)) {
				await mkdir(targetDir, { recursive: true });
			}

			// Copy legacy file to new location
			await copyFile(this.legacyWorkspacesFile, this.workspacesFile);
			log.info(
				`✅ Migrated workspaces from ${this.legacyWorkspacesFile} to ${this.workspacesFile}`,
			);
		} catch (error) {
			log.error(`Failed to migrate workspaces file: ${error}`);
		}
	}

	async loadWorkspaces(): Promise<AgentWorkspace[]> {
		// Check for migration
		await this.migrateFromLegacy();

		try {
			if (!existsSync(this.workspacesFile)) {
				log.debug("No workspaces file found");
				return [];
			}

			const content = await readFile(this.workspacesFile, "utf-8");
			const data: WorkspacesData = JSON.parse(content);

			if (data.version !== 1) {
				log.warn(`Unknown workspaces file version: ${data.version}`);
				return [];
			}

			log.info(`Loaded ${data.workspaces.length} workspaces from disk`);
			return data.workspaces;
		} catch (error) {
			log.error("Failed to load workspaces:", error);
			return [];
		}
	}

	async saveWorkspaces(workspaces: AgentWorkspace[]): Promise<void> {
		try {
			const data: WorkspacesData = {
				version: 1,
				workspaces,
			};

			const content = JSON.stringify(data, null, 2);

			// Ensure directory exists
			const dir = dirname(this.workspacesFile);
			if (!existsSync(dir)) {
				await mkdir(dir, { recursive: true });
			}

			await writeFile(this.workspacesFile, content, "utf-8");
			log.info(`Saved ${workspaces.length} workspaces to disk`);
		} catch (error) {
			log.error("Failed to save workspaces:", error);
		}
	}
}

export const workspacePersistence = new WorkspacePersistence();
