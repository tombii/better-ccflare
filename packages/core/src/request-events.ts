import { EventEmitter } from "node:events";

export type RequestStartEvt = {
	type: "start";
	id: string;
	timestamp: number;
	method: string;
	path: string;
	accountId: string | null;
	statusCode: number;
	agentUsed: string | null;
};

export type RequestSummaryEvt = {
	type: "summary";
	payload: import("@better-ccflare/types").RequestResponse;
};

export type RequestPayloadEvt = {
	type: "payload";
	payload: import("@better-ccflare/types").RequestPayload;
};

export type RequestEvt =
	| RequestStartEvt
	| RequestSummaryEvt
	| RequestPayloadEvt;

class RequestEventBus extends EventEmitter {}
export const requestEvents = new RequestEventBus();
