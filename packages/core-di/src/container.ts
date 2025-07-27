type ServiceFactory<T> = () => T;
type ServiceKey = string | symbol;

class Container {
	private services = new Map<ServiceKey, unknown>();
	private factories = new Map<ServiceKey, ServiceFactory<unknown>>();

	register<T>(key: ServiceKey, factory: ServiceFactory<T>): void {
		this.factories.set(key, factory);
	}

	registerInstance<T>(key: ServiceKey, instance: T): void {
		this.services.set(key, instance);
	}

	resolve<T>(key: ServiceKey): T {
		// Check if instance already exists
		if (this.services.has(key)) {
			return this.services.get(key) as T;
		}

		// Check if factory exists
		const factory = this.factories.get(key);
		if (!factory) {
			throw new Error(`Service '${String(key)}' not registered`);
		}

		// Create instance and cache it (singleton)
		const instance = factory();
		this.services.set(key, instance);
		return instance as T;
	}

	has(key: ServiceKey): boolean {
		return this.factories.has(key) || this.services.has(key);
	}

	clear(): void {
		this.services.clear();
		this.factories.clear();
	}
}

// Global container instance
export const container = new Container();
