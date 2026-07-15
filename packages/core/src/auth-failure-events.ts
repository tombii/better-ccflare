import { EventEmitter } from "node:events";

export interface AuthFailureEvt {
	accountId: string;
	accountName: string;
	provider: string;
	reason: string;
}

class AuthFailureEventBus extends EventEmitter {}
export const authFailureEvents = new AuthFailureEventBus();

authFailureEvents.setMaxListeners(200);
