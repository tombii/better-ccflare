export interface ProxyRequest {
	method: string;
	path: string;
	headers: Headers;
	body: ArrayBuffer | null;
	query: string;
}

export interface ProxyResponse {
	status: number;
	statusText: string;
	headers: Headers;
	body: ReadableStream<Uint8Array> | string | null;
}
