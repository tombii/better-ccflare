export interface LogEvent {
	ts: number;
	level: "DEBUG" | "INFO" | "WARN" | "ERROR";
	msg: string;
}
