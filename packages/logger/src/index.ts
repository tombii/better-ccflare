export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
}

export type LogFormat = "pretty" | "json";

export class Logger {
	private level: LogLevel;
	private prefix: string;
	private format: LogFormat;

	constructor(prefix: string = "", level: LogLevel = LogLevel.INFO) {
		this.prefix = prefix;
		this.level = this.getLogLevelFromEnv() || level;
		this.format = (process.env.LOG_FORMAT as LogFormat) || "pretty";
	}

	private getLogLevelFromEnv(): LogLevel | null {
		const envLevel = process.env.LOG_LEVEL?.toUpperCase();
		if (envLevel && envLevel in LogLevel) {
			return LogLevel[envLevel as keyof typeof LogLevel];
		}
		return null;
	}

	// biome-ignore lint/suspicious/noExplicitAny: Logger needs to accept any data type
	private formatMessage(level: string, message: string, data?: any): string {
		const timestamp = new Date().toISOString();

		if (this.format === "json") {
			const logEntry = {
				ts: timestamp,
				level,
				prefix: this.prefix || undefined,
				msg: message,
				...(data && { data }),
			};
			return JSON.stringify(logEntry);
		} else {
			const prefix = this.prefix ? `[${this.prefix}] ` : "";
			const dataStr = data ? ` ${JSON.stringify(data)}` : "";
			return `[${timestamp}] ${level}: ${prefix}${message}${dataStr}`;
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Logger needs to accept any data type
	debug(message: string, data?: any): void {
		if (this.level <= LogLevel.DEBUG) {
			console.log(this.formatMessage("DEBUG", message, data));
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Logger needs to accept any data type
	info(message: string, data?: any): void {
		if (this.level <= LogLevel.INFO) {
			console.log(this.formatMessage("INFO", message, data));
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Logger needs to accept any data type
	warn(message: string, data?: any): void {
		if (this.level <= LogLevel.WARN) {
			console.warn(this.formatMessage("WARN", message, data));
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: Logger needs to accept any error type
	error(message: string, error?: any): void {
		if (this.level <= LogLevel.ERROR) {
			console.error(this.formatMessage("ERROR", message), error);
		}
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	getLevel(): LogLevel {
		return this.level;
	}
}

// Default logger instance
export const log = new Logger();
