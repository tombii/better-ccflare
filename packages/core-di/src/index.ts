import { container as _container } from "./container";

export const container = _container;

// Service keys - using symbols for better encapsulation
export const SERVICE_KEYS = {
	Config: Symbol("Config"),
	Database: Symbol("Database"),
	AsyncWriter: Symbol("AsyncWriter"),
} as const;
