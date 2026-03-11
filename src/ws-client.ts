/**
 * Agent WebSocket Client
 *
 * Maintains a persistent WebSocket connection to the AutoKube dashboard.
 * Protocol:
 *   ↔ Agent connects to ws(s)://<url>/api/agent/ws?token=xxx
 *   ← AutoKube sends JSON: { id, type: 'k8s-request', path, method?, body?, headers?, timeout? }
 *   → Agent executes against the local K8s API
 *   → Agent sends JSON: { id, type: 'k8s-response', status, body, headers? }
 *   ← AutoKube sends 'ping' frames; agent auto-replies with 'pong'
 *   ← AutoKube sends JSON: { id, type: 'exec-start', namespace, pod, container, shell, cols, rows }
 *   → Agent opens K8s exec WS locally and relays stdin/stdout/stderr
 */

import type { K8sClient } from './k8s-client';
import type { ExecHandle } from './k8s-client';

interface AgentK8sRequest {
	id: string;
	type: 'k8s-request';
	path: string;
	method?: string;
	body?: string;
	headers?: Record<string, string>;
	timeout?: number;
}

interface AgentExecStart {
	id: string;
	type: 'exec-start';
	namespace: string;
	pod: string;
	container: string;
	shell: string;
	cols: number;
	rows: number;
}

interface AgentExecStdin {
	type: 'exec-stdin';
	sessionId: string;
	data: string;
}

interface AgentExecResize {
	type: 'exec-resize';
	sessionId: string;
	cols: number;
	rows: number;
}

interface AgentExecClose {
	type: 'exec-close';
	sessionId: string;
}

interface AgentExecOneshot {
	id: string;
	type: 'exec-oneshot';
	namespace: string;
	pod: string;
	container: string;
	command: string[];
	maxBytes?: number;
	timeout?: number;
}

interface AgentK8sResponse {
	id: string;
	type: 'k8s-response';
	status: number;
	body: string;
	headers?: Record<string, string>;
}

const NO_SHELL_PATTERNS = [
	'no_shell',
	'no such file or directory',
	'executable file not found',
	'not found',
	'oci runtime exec failed',
	'failed to exec',
	'exit code 126',
	'exit code 127',
	'shell exited immediately'
];

function isNoShellError(errorMessage: string): boolean {
	const normalized = errorMessage.trim().toLowerCase();
	return NO_SHELL_PATTERNS.some((pattern) => normalized.includes(pattern));
}

// Reconnection configuration
const INITIAL_RECONNECT_DELAY = 1_000;
const MAX_RECONNECT_DELAY = 30_000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;

export class AgentWsClient {
	private ws: WebSocket | null = null;
	private running = false;
	private reconnectDelay = INITIAL_RECONNECT_DELAY;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	/** Active exec sessions: sessionId → ExecHandle */
	private execSessions = new Map<string, ExecHandle>();

	constructor(
		private readonly serverUrl: string,
		private readonly token: string,
		private readonly k8s: K8sClient
	) {}

	/**
	 * Ask AutoKube for the preferred WebSocket endpoint.
	 * In dev, the dashboard exposes `/api/agent/discover` and may point the
	 * agent at a separate Bun-native WebSocket server. In production this
	 * endpoint can be absent, in which case we fall back to the canonical path.
	 */
	private async discoverWsBaseUrl(): Promise<string | null> {
		const base = this.serverUrl.replace(/\/+$/, '');
		const discoverUrl = `${base}/api/agent/discover`;

		try {
			const response = await fetch(discoverUrl, {
				headers: { Accept: 'application/json' }
			});

			if (!response.ok) {
				return null;
			}

			const data = await response.json();
			if (data && typeof data.wsUrl === 'string' && data.wsUrl.length > 0) {
				return data.wsUrl;
			}
		} catch {
			// Discovery is optional; fall back to the canonical URL below.
		}

		return null;
	}

	/**
	 * Build the WebSocket URL from the server URL
	 */
	private async buildWsUrl(): Promise<string> {
		const discovered = await this.discoverWsBaseUrl();
		if (discovered) {
			const base = discovered.replace(/\/+$/, '');
			const separator = base.includes('?') ? '&' : '?';
			return `${base}${separator}token=${encodeURIComponent(this.token)}`;
		}

		// Convert http(s):// to ws(s)://
		const wsUrl = this.serverUrl
			.replace(/^https:\/\//, 'wss://')
			.replace(/^http:\/\//, 'ws://');

		// Strip trailing slashes
		const base = wsUrl.replace(/\/+$/, '');
		return `${base}/api/agent/ws?token=${encodeURIComponent(this.token)}`;
	}

	/**
	 * Start the WebSocket connection
	 */
	start(): void {
		this.running = true;
		this.connect();
		console.log('[ws] Connecting to AutoKube…');
	}

	/**
	 * Stop and close the WebSocket connection
	 */
	stop(): void {
		this.running = false;

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		// Close all exec sessions
		for (const [sid, handle] of this.execSessions) {
			try { handle.close(); } catch { /* ignore */ }
			this.execSessions.delete(sid);
		}

		if (this.ws) {
			this.ws.close(1000, 'Agent shutting down');
			this.ws = null;
		}

		console.log('[ws] Stopped');
	}

	/**
	 * Open a WebSocket connection
	 */
	private async connect(): Promise<void> {
		if (!this.running) return;

		const url = await this.buildWsUrl();

		try {
			this.ws = new WebSocket(url);
		} catch (err) {
			console.error('[ws] Failed to create WebSocket:', err);
			this.scheduleReconnect();
			return;
		}

		this.ws.onopen = () => {
			console.log('[ws] Connected to AutoKube');
			this.reconnectDelay = INITIAL_RECONNECT_DELAY;
		};

		this.ws.onmessage = (event) => {
			this.handleMessage(event.data);
		};

		this.ws.onclose = (event) => {
			const reason = event.reason || 'unknown';
			console.log(`[ws] Connection closed: code=${event.code} reason=${reason}`);
			this.ws = null;

			if (this.running) {
				this.scheduleReconnect();
			}
		};

		this.ws.onerror = (event) => {
			console.error('[ws] WebSocket error:', event);
			// onclose will fire after onerror, triggering reconnect
		};
	}

	/**
	 * Schedule a reconnection with exponential backoff
	 */
	private scheduleReconnect(): void {
		if (!this.running) return;

		console.log(`[ws] Reconnecting in ${this.reconnectDelay / 1000}s…`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, this.reconnectDelay);

		this.reconnectDelay = Math.min(
			this.reconnectDelay * RECONNECT_BACKOFF_MULTIPLIER,
			MAX_RECONNECT_DELAY
		);
	}

	/**
	 * Handle an incoming WebSocket message
	 */
	private handleMessage(data: string | ArrayBuffer | Buffer): void {
		const raw = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);

		// Handle text ping from server
		if (raw === 'ping') {
			this.ws?.send('pong');
			return;
		}

		let msg: { type: string; id?: string; [key: string]: unknown };
		try {
			msg = JSON.parse(raw);
		} catch {
			console.warn('[ws] Received non-JSON message:', raw.slice(0, 100));
			return;
		}

		if (msg.type === 'connected') {
			return;
		}

		if (msg.type === 'k8s-request' && msg.id) {
			this.handleK8sRequest(msg as unknown as AgentK8sRequest).catch((err) => {
				console.error(`[ws] Unhandled error in request handler: ${err}`);
			});
			return;
		}

		// ── Exec protocol messages ──────────────────────────────────────
		if (msg.type === 'exec-start' && msg.id) {
			this.handleExecStart(msg as unknown as AgentExecStart).catch((err) => {
				console.error(`[ws] Exec start error: ${err}`);
			});
			return;
		}

		if (msg.type === 'exec-stdin') {
			const m = msg as unknown as AgentExecStdin;
			const handle = this.execSessions.get(m.sessionId);
			if (handle) {
				handle.sendStdin(m.data);
			}
			return;
		}

		if (msg.type === 'exec-resize') {
			const m = msg as unknown as AgentExecResize;
			const handle = this.execSessions.get(m.sessionId);
			if (handle) {
				handle.sendResize(m.cols, m.rows);
			}
			return;
		}

		if (msg.type === 'exec-close') {
			const m = msg as unknown as AgentExecClose;
			const handle = this.execSessions.get(m.sessionId);
			if (handle) {
				handle.close();
				this.execSessions.delete(m.sessionId);
			}
			return;
		}

		if (msg.type === 'exec-oneshot' && msg.id) {
			this.handleExecOneshot(msg as unknown as AgentExecOneshot).catch((err) => {
				console.error(`[ws] Exec oneshot error: ${err}`);
			});
			return;
		}

		console.warn(`[ws] Unknown message type: ${msg.type}`);
	}

	/**
	 * Execute a Kubernetes API request and send back the response
	 */
	private async handleK8sRequest(req: AgentK8sRequest): Promise<void> {
		const label = `${req.method ?? 'GET'} ${req.path}`;

		try {
			const result = await this.k8s.request(req.path, {
				method: req.method ?? 'GET',
				body: req.body,
				headers: req.headers,
				timeout: req.timeout ?? 30_000
			});

			this.sendResponse({
				id: req.id,
				type: 'k8s-response',
				status: result.status,
				body: result.body,
				headers: result.headers
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.error(`[ws] K8s request failed: ${label} — ${errorMsg}`);

			this.sendResponse({
				id: req.id,
				type: 'k8s-response',
				status: 502,
				body: JSON.stringify({ error: errorMsg })
			});
		}
	}

	/**
	 * Send a JSON response back through the WebSocket
	 */
	private sendResponse(response: AgentK8sResponse): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			console.warn(`[ws] Cannot send response ${response.id}: WebSocket not open`);
			return;
		}

		try {
			this.ws.send(JSON.stringify(response));
		} catch (err) {
			console.error(`[ws] Failed to send response ${response.id}:`, err);
		}
	}

	/**
	 * Send any JSON message through the WebSocket
	 */
	private sendJson(msg: Record<string, unknown>): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			this.ws.send(JSON.stringify(msg));
		} catch (err) {
			console.error('[ws] Failed to send message:', err);
		}
	}

	/**
	 * Handle an exec-start request: open a K8s exec WebSocket locally,
	 * then relay stdin/stdout/stderr through the AutoKube WS connection.
	 */
	private async handleExecStart(req: AgentExecStart): Promise<void> {
		const sessionId = crypto.randomUUID();

		try {
			const label = `${req.pod}/${req.container}`;

			const handle = await this.k8s.exec({
				namespace: req.namespace,
				pod: req.pod,
				container: req.container,
				shell: req.shell,
				cols: req.cols,
				rows: req.rows,
				onData: (channel, data) => {
					this.sendJson({
						type: 'exec-output',
						sessionId,
						channel,
						data
					});
				},
				onClose: (code, reason) => {
					const detail = reason ? ` — ${reason.replace(/\n+/g, ' | ')}` : '';
					const codeStr = code !== undefined ? ` (code ${code})` : '';
					console.log(`[exec] Session ${sessionId.slice(0, 8)} closed: ${label}${codeStr}${detail}`);
					this.sendJson({
						type: 'exec-closed',
						sessionId,
						code,
						reason
					});
					this.execSessions.delete(sessionId);
				},
				onError: (err) => {
					const logMsg = err.message.replace(/\n+/g, ' | ');
					console.error(`[exec] Session ${sessionId.slice(0, 8)} error: ${label} — ${logMsg}`);
					this.sendJson({
						type: 'exec-closed',
						sessionId,
						code: 1,
						reason: err.message
					});
					this.execSessions.delete(sessionId);
				}
			});

			this.execSessions.set(sessionId, handle);

			// Tell the server the session is ready
			this.sendJson({
				id: req.id,
				type: 'exec-started',
				sessionId
			});

			console.log(`[exec] Session ${sessionId.slice(0, 8)} started: ${label} (${req.shell})`);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			const logMsg = errorMsg.replace(/\n+/g, ' | ');
			console.error(`[exec] Failed to start: ${req.pod}/${req.container} — ${logMsg}`);

			this.sendJson({
				id: req.id,
				type: 'exec-error',
				error: isNoShellError(errorMsg) ? 'NO_SHELL' : errorMsg
			});
		}
	}

	/**
	 * Handle a one-shot command execution request.
	 * Runs the command in the container without a TTY and returns stdout/stderr.
	 */
	private async handleExecOneshot(req: AgentExecOneshot): Promise<void> {
		try {
			const { stdout, stderr } = await this.k8s.execOneshot({
				namespace: req.namespace,
				pod: req.pod,
				container: req.container,
				command: req.command,
				maxBytes: req.maxBytes,
				timeout: req.timeout
			});
			this.sendJson({
				id: req.id,
				type: 'exec-oneshot-result',
				stdout,
				stderr
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.error(`[exec-oneshot] Error: ${req.pod}/${req.container} — ${errorMsg.replace(/\n+/g, ' | ')}`);
			this.sendJson({
				id: req.id,
				type: 'exec-oneshot-error',
				error: errorMsg
			});
		}
	}
}
