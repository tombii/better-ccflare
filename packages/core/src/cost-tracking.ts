/** Runtime mirror of the persisted setting, initialized at boot and on writes. */
let enabled = true;
// Incrementing on disable also invalidates pricing that was already in flight,
// even if tracking is enabled again before that asynchronous work completes.
let epoch = 0;

export function setCostTrackingEnabled(value: boolean): void {
	if (!value && enabled) epoch++;
	enabled = value;
}

export function isCostTrackingEnabled(): boolean {
	return enabled;
}

export function getCostTrackingEpoch(): number {
	return epoch;
}
