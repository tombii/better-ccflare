/**
 * Sail completion-tier adapter for the shared night-window layer.
 *
 * Inside the window we ask Sail for the lower-priority `balanced` tier;
 * outside it we send no header at all, because Sail's `asap` is the default
 * and sending it explicitly 400s on custom tools / background requests.
 */

import { registerTierAdapter } from "../../night-window";

registerTierAdapter({
	provider: "sailresearch",
	header: "x-sail-completion-window",
	tier: "balanced",
});
