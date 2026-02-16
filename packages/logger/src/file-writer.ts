import {
	createWriteStream,
	existsSync,
	mkdirSync,
	statSync,
	truncateSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "@better-ccflare/types";

// Local constants to avoid circular dependency with core
const BUFFER_SIZES = {
	LOG_FILE_MAX_SIZE: 10 * 1024 * 1024, // 10MB
} as const;

const LIMITS = {
	LOG_MESSAGE_MAX_LENGTH: 10000,
	LOG_READ_DEFAULT: 1000,
} as const;

// Simple disposable interface to avoid circular dependency
interface Disposable {
	dispose(): void;
}

const disposables = new Set<Disposable>();

function registerDisposable(disposable: Disposable): void {
	disposables.add(disposable);
}

export class LogFileWriter implements Disposable {
	private logDir: string;
	private logFile: string;
	private stream: ReturnType<typeof createWriteStream> | null = null;
	private maxFileSize = BUFFER_SIZES.LOG_FILE_MAX_SIZE;

	constructor() {
		// Use environment variable if set, otherwise use tmp folder
		this.logDir =
			process.env.BETTER_CCFLARE_LOG_DIR ||
			join(tmpdir(), "better-ccflare-logs");
		if (!existsSync(this.logDir)) {
			mkdirSync(this.logDir, { recursive: true });
		}

		this.logFile = join(this.logDir, "app.log");
		this.initStream();
	}

	private initStream(): void {
		// Close existing stream if any
		if (this.stream && !this.stream.destroyed) {
			this.stream.end();
			this.stream = null;
		}

		// Check if we need to rotate
		if (existsSync(this.logFile)) {
			const stats = statSync(this.logFile);
			if (stats.size > this.maxFileSize) {
				this.rotateLog();
			}
		}

		// Create write stream with append mode
		this.stream = createWriteStream(this.logFile, { flags: "a" });
	}

	private rotateLog(): void {
		if (this.stream) {
			this.stream.end();
			this.stream = null;
		}

		if (existsSync(this.logFile)) {
			try {
				unlinkSync(this.logFile);
			} catch (e: unknown) {
				const code = (e as NodeJS.ErrnoException).code;
				if (code === "EACCES" || code === "EPERM") {
					// Fallback: try truncating the file instead
					try {
						truncateSync(this.logFile, 0);
					} catch (_truncErr) {
						// Last resort: switch to a timestamped log file
						this.logFile = join(this.logDir, `app-${Date.now()}.log`);
					}
				} else {
					console.error("Failed to rotate log:", e);
				}
			}
		}
	}

	write(event: LogEvent): void {
		if (!this.stream || this.stream.destroyed) {
			this.initStream();
		}

		// Periodic size check to trigger rotation mid-stream
		try {
			if (existsSync(this.logFile)) {
				const stats = statSync(this.logFile);
				if (stats.size > this.maxFileSize) {
					this.rotateLog();
					this.initStream();
				}
			}
		} catch {
			// Ignore stat errors, will be caught on next initStream
		}

		const line = `${JSON.stringify(event)}\n`;
		if (this.stream) {
			this.stream.write(line);
		}
	}

	async readLogs(limit: number = LIMITS.LOG_READ_DEFAULT): Promise<LogEvent[]> {
		if (!existsSync(this.logFile)) {
			return [];
		}

		try {
			const content = await Bun.file(this.logFile).text();
			const lines = content.trim().split("\n").filter(Boolean);

			// Return the last N logs
			return lines
				.slice(-limit)
				.map((line) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter((log): log is LogEvent => log !== null);
		} catch (_e) {
			console.error("Failed to read logs:", _e);
			return [];
		}
	}

	close(): void {
		if (this.stream) {
			this.stream.end();
			this.stream = null;
		}
	}

	dispose(): void {
		this.close();
	}
}

// Check if we're in a Node.js/Bun environment (not browser)
const isNodeEnvironment =
	typeof process !== "undefined" &&
	process.versions != null &&
	process.versions.node != null;

// Singleton instance - only create in Node.js environments
export const logFileWriter: LogFileWriter | null = isNodeEnvironment
	? new LogFileWriter()
	: null;

// Register with lifecycle manager (only in Node.js)
if (logFileWriter) {
	registerDisposable(logFileWriter);
}
