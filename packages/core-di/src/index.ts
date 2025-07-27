import { container as _container } from "./container";

export const container = _container;

// Service keys - using symbols for better encapsulation
export const SERVICE_KEYS = {
	Logger: Symbol("Logger"),
	Config: Symbol("Config"),
	Database: Symbol("Database"),
	PricingLogger: Symbol("PricingLogger"),
	AsyncWriter: Symbol("AsyncWriter"),
} as const;

// Type-safe service resolution helper
export function getService<T>(key: keyof typeof SERVICE_KEYS): T {
	return container.resolve<T>(SERVICE_KEYS[key]);
}
