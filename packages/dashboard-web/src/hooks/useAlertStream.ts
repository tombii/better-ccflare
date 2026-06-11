import { useEffect, useRef, useState } from "react";

export interface AlertStreamEvent {
	type: "alert";
	payload: {
		id: string;
		timestamp: number;
		type: string;
		severity: string;
		title: string;
		message: string;
		value: number | null;
		threshold: number | null;
		account: string | null;
		model: string | null;
		project: string | null;
		requestId: string | null;
		acknowledged: boolean;
	};
}

interface UseAlertStreamOptions {
	enabled?: boolean;
	onAlert?: (event: AlertStreamEvent) => void;
}

export function useAlertStream(options: UseAlertStreamOptions = {}) {
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const onAlertRef = useRef(options.onAlert);

	// Keep ref current without causing re-renders
	useEffect(() => {
		onAlertRef.current = options.onAlert;
	}, [options.onAlert]);

	useEffect(() => {
		// Opt-out only when explicitly disabled
		if (options.enabled === false) return;

		let evtSource: EventSource | null = null;
		let alive = true;

		const connect = () => {
			try {
				setConnected(false);
				setError(null);
				evtSource = new EventSource("/api/insights/alerts/stream");

				evtSource.addEventListener("connected", () => {
					if (!alive) return;
					setConnected(true);
				});

				evtSource.onmessage = (event) => {
					if (!alive) return;
					try {
						const data = JSON.parse(event.data) as AlertStreamEvent;
						onAlertRef.current?.(data);
					} catch (err) {
						console.warn("Malformed alert event:", err);
					}
				};

				evtSource.onerror = () => {
					if (!alive) return;
					setError("Connection lost — reconnecting…");
					setConnected(false);
				};
			} catch (err) {
				setError((err as Error).message);
			}
		};

		connect();

		return () => {
			alive = false;
			evtSource?.close();
		};
	}, [options.enabled]);

	return { connected, error };
}
