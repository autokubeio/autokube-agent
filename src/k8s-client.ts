/**
 * In-Cluster Kubernetes Client
 *
 * Uses the ServiceAccount token mounted at /var/run/secrets/kubernetes.io/serviceaccount/
 * to authenticate against the cluster's internal API server (https://kubernetes.default.svc).
 *
 * In dev mode (outside a cluster), falls back to KUBECONFIG or kubectl proxy at localhost:8001.
 */

import { readFileSync, existsSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

// Standard in-cluster paths
const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const SA_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';

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

function isNoShellErrorMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return NO_SHELL_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function formatNoShellError(shell: string): string {
	return `NO_SHELL: This container has no shell installed. Common with distroless or scratch-based images.\n\nTried: ${shell}`;
}

export class K8sClient {
	apiServer = '';
	private token = '';
	private caCert: Buffer | undefined;
	private inCluster = false;
	namespace = 'default';

	/**
	 * Initialise client — auto-detect in-cluster vs dev mode
	 */
	async init(): Promise<void> {
		if (existsSync(SA_TOKEN_PATH)) {
			// Running inside Kubernetes with a ServiceAccount
			this.inCluster = true;
			this.token = readFileSync(SA_TOKEN_PATH, 'utf-8').trim();
			this.caCert = readFileSync(SA_CA_PATH);
			this.namespace = readFileSync(SA_NAMESPACE_PATH, 'utf-8').trim();
			this.apiServer = 'https://kubernetes.default.svc';
			console.log('[k8s] In-cluster mode — ServiceAccount detected');
			console.log(`[k8s] Namespace: ${this.namespace}`);
		} else {
			// Dev mode — try kubectl proxy or KUBERNETES_SERVICE_HOST
			const host = process.env.KUBERNETES_SERVICE_HOST;
			const port = process.env.KUBERNETES_SERVICE_PORT;

			if (host && port) {
				this.apiServer = `https://${host}:${port}`;
				this.token = process.env.KUBE_TOKEN ?? '';
				console.log(`[k8s] Dev mode — using KUBERNETES_SERVICE_HOST=${host}:${port}`);
			} else {
				// Fallback: kubectl proxy at localhost:8001
				this.apiServer = 'http://localhost:8001';
				console.log('[k8s] Dev mode — using kubectl proxy at localhost:8001');
				console.log('[k8s] Run: kubectl proxy --port=8001');
			}
		}
	}

	/**
	 * Refresh the ServiceAccount token (supports projected/rotated tokens)
	 */
	private refreshToken(): void {
		if (this.inCluster && existsSync(SA_TOKEN_PATH)) {
			this.token = readFileSync(SA_TOKEN_PATH, 'utf-8').trim();
		}
	}

	/**
	 * Make a request to the Kubernetes API server
	 */
	async request(
		path: string,
		options: {
			method?: string;
			body?: string;
			headers?: Record<string, string>;
			timeout?: number;
		} = {}
	): Promise<{ status: number; body: string; headers: Record<string, string> }> {
		// Refresh token on every call (supports projected token rotation)
		this.refreshToken();

		const url = new URL(path, this.apiServer);
		const isHttps = url.protocol === 'https:';
		const transport = isHttps ? https : http;

		const method = options.method ?? 'GET';
		const timeout = options.timeout ?? 30_000;

		const reqHeaders: Record<string, string> = {
			Accept: 'application/json',
			...options.headers
		};

		if (this.token) {
			reqHeaders['Authorization'] = `Bearer ${this.token}`;
		}

		if (options.body) {
			reqHeaders['Content-Type'] = 'application/json';
			reqHeaders['Content-Length'] = Buffer.byteLength(options.body).toString();
		}

		return new Promise((resolve, reject) => {
			const reqOptions: https.RequestOptions = {
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: url.pathname + url.search,
				method,
				headers: reqHeaders,
				timeout,
				...(isHttps && this.caCert ? { ca: this.caCert, rejectUnauthorized: true } : {}),
				...(isHttps && !this.caCert ? { rejectUnauthorized: false } : {})
			};

			const req = transport.request(reqOptions, (res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					const body = Buffer.concat(chunks).toString('utf-8');
					const responseHeaders: Record<string, string> = {};
					for (const [k, v] of Object.entries(res.headers)) {
						if (typeof v === 'string') responseHeaders[k] = v;
						else if (Array.isArray(v)) responseHeaders[k] = v.join(', ');
					}
					resolve({
						status: res.statusCode ?? 500,
						body,
						headers: responseHeaders
					});
				});
			});

			req.on('timeout', () => {
				req.destroy();
				reject(new Error(`K8s API request timeout after ${timeout}ms: ${method} ${path}`));
			});

			req.on('error', (err) => {
				reject(new Error(`K8s API request error: ${method} ${path} — ${err.message}`));
			});

			if (options.body) {
				req.write(options.body);
			}

			req.end();
		});
	}

	/**
	 * Open a K8s exec WebSocket session.
	 * Uses raw TLS/TCP socket + manual HTTP/1.1 upgrade, the same pattern as
	 * the AutoKube server (reliable across Bun + K8s API versions).
	 *
	 * Returns an ExecHandle with methods to send stdin, resize, and close.
	 */
	async exec(opts: {
		namespace: string;
		pod: string;
		container: string;
		shell: string;
		cols: number;
		rows: number;
		onData: (channel: number, data: string) => void;
		onClose?: (code?: number, reason?: string) => void;
		onError?: (err: Error) => void;
	}): Promise<ExecHandle> {
		this.refreshToken();

		const qs = new URLSearchParams({
			stdout: '1',
			stderr: '1',
			stdin: '1',
			tty: '1',
			container: opts.container,
			command: opts.shell
		});

		const execPath =
			`/api/v1/namespaces/${encodeURIComponent(opts.namespace)}` +
			`/pods/${encodeURIComponent(opts.pod)}` +
			`/exec?${qs.toString()}`;

		const url = new URL(execPath, this.apiServer);
		const hostname = url.hostname;
		const port = parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80);
		const path = url.pathname + url.search;
		const isSecure = this.apiServer.startsWith('https');

		return new Promise<ExecHandle>((resolve, reject) => {
			let settled = false;

			const tlsOptions: tls.ConnectionOptions = {
				host: hostname,
				port,
				rejectUnauthorized: !!this.caCert,
				servername: hostname,
				...(this.caCert ? { ca: this.caCert } : {})
			};

			const socket: net.Socket | tls.TLSSocket = isSecure
				? tls.connect(tlsOptions)
				: net.connect({ host: hostname, port });

			const connectEvent = isSecure ? 'secureConnect' : 'connect';

			const timeout = setTimeout(() => {
				if (!settled) {
					settled = true;
					socket.destroy();
					reject(new Error('Exec connection timed out'));
				}
			}, 15_000);

			socket.once(connectEvent, () => {
				const wsKey = Buffer.from(randomUUID()).toString('base64');
				const headers = [
					`GET ${path} HTTP/1.1`,
					`Host: ${hostname}`,
					'Connection: Upgrade',
					'Upgrade: websocket',
					`Sec-WebSocket-Key: ${wsKey}`,
					'Sec-WebSocket-Version: 13',
					'Sec-WebSocket-Protocol: v4.channel.k8s.io'
				];
				if (this.token) {
					headers.push(`Authorization: Bearer ${this.token}`);
				}
				headers.push('', '');
				socket.write(headers.join('\r\n'));
			});

			let headerBuf = '';
			let upgraded = false;
			let frameBuffer: Buffer = Buffer.alloc(0);
			let earlyError: string | null = null;

			const handle: ExecHandle = {
				sendStdin(data: string) {
					const payload = Buffer.alloc(1 + Buffer.byteLength(data, 'utf8'));
					payload[0] = 0;
					payload.write(data, 1, 'utf8');
					sendWsFrame(socket, 0x02, payload);
				},
				sendResize(cols: number, rows: number) {
					const json = JSON.stringify({ Width: cols, Height: rows });
					const payload = Buffer.alloc(1 + Buffer.byteLength(json, 'utf8'));
					payload[0] = 4;
					payload.write(json, 1, 'utf8');
					sendWsFrame(socket, 0x02, payload);
				},
				close() {
					try { socket.destroy(); } catch { /* ignore */ }
				}
			};

			socket.on('data', (chunk: Buffer) => {
				if (!upgraded) {
					headerBuf += chunk.toString('binary');
					const headerEnd = headerBuf.indexOf('\r\n\r\n');
					if (headerEnd === -1) return;

					const headerStr = headerBuf.substring(0, headerEnd);
					const firstLine = headerStr.split('\r\n')[0];

					if (!firstLine.includes('101')) {
						clearTimeout(timeout);
						if (!settled) {
							settled = true;
							const body = headerBuf.substring(headerEnd + 4).slice(0, 500);
							socket.destroy();
							reject(new Error(`Exec failed: ${firstLine} — ${body}`));
						}
						return;
					}

					upgraded = true;

					const remaining = Buffer.from(headerBuf.substring(headerEnd + 4), 'binary');
					if (remaining.length > 0) {
						frameBuffer = Buffer.concat([frameBuffer, remaining]);
						frameBuffer = processExecFrames(frameBuffer, opts, handle, socket);
					}

					// Send initial resize
					handle.sendResize(opts.cols, opts.rows);

					clearTimeout(timeout);

					// Wait briefly for early shell failures
					const earlyTimer = setTimeout(() => {
						if (!settled) {
							settled = true;
							resolve(handle);
						}
					}, 500);

					// Override close/error to catch early failures
					const origOnClose = opts.onClose;
					const origOnError = opts.onError;

					opts.onClose = (code, reason) => {
						if (!settled) {
							settled = true;
							clearTimeout(earlyTimer);
							socket.destroy();
							reject(new Error(earlyError || `Shell exited immediately (code ${code})`));
							return;
						}
						origOnClose?.(code, reason);
					};

					opts.onError = (err) => {
						earlyError = err.message;
						if (!settled) {
							settled = true;
							clearTimeout(earlyTimer);
							socket.destroy();
							reject(err);
							return;
						}
						origOnError?.(err);
					};
				} else {
					frameBuffer = Buffer.concat([frameBuffer, chunk]);
					frameBuffer = processExecFrames(frameBuffer, opts, handle, socket);
				}
			});

			socket.on('close', () => {
				clearTimeout(timeout);
				if (!settled) {
					settled = true;
					reject(new Error('Connection closed before upgrade completed'));
				} else {
					opts.onClose?.();
				}
			});

			socket.on('error', (err) => {
				clearTimeout(timeout);
				if (!settled) {
					settled = true;
					reject(new Error(`Exec connection failed: ${err.message}`));
				} else {
					opts.onError?.(err);
				}
			});
		});
	}

	/**
	 * Run a one-shot non-interactive command in a container.
	 * tty=false, stdin=false — just collects stdout and stderr then resolves.
	 */
	async execOneshot(opts: {
		namespace: string;
		pod: string;
		container: string;
		command: string[];
		maxBytes?: number;
		timeout?: number;
	}): Promise<{ stdout: string; stderr: string }> {
		this.refreshToken();

		const qs = new URLSearchParams({
			stdout: '1',
			stderr: '1',
			stdin: '0',
			tty: '0',
			container: opts.container
		});
		for (const arg of opts.command) qs.append('command', arg);

		const execPath =
			`/api/v1/namespaces/${encodeURIComponent(opts.namespace)}` +
			`/pods/${encodeURIComponent(opts.pod)}` +
			`/exec?${qs.toString()}`;

		const url = new URL(execPath, this.apiServer);
		const hostname = url.hostname;
		const port = parseInt(url.port) || (this.apiServer.startsWith('https') ? 443 : 80);
		const path = url.pathname + url.search;
		const isSecure = this.apiServer.startsWith('https');

		const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
		const timeoutMs = opts.timeout ?? 30_000;

		return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
			const tlsOptions: tls.ConnectionOptions = {
				host: hostname,
				port,
				rejectUnauthorized: !!this.caCert,
				servername: hostname,
				...(this.caCert ? { ca: this.caCert } : {})
			};

			const socket: net.Socket | tls.TLSSocket = isSecure
				? tls.connect(tlsOptions)
				: net.connect({ host: hostname, port });

			const connectEvent = isSecure ? 'secureConnect' : 'connect';

			let settled = false;
			let stdout = '';
			let stderr = '';
			let totalBytes = 0;

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					socket.destroy();
					reject(new Error('Command timed out'));
				}
			}, timeoutMs);

			function done(err?: Error) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try { socket.destroy(); } catch { /* ignore */ }
				if (err) reject(err);
				else resolve({ stdout, stderr });
			}

			socket.once(connectEvent, () => {
				const wsKey = Buffer.from(randomUUID()).toString('base64');
				const headers = [
					`GET ${path} HTTP/1.1`,
					`Host: ${hostname}`,
					'Connection: Upgrade',
					'Upgrade: websocket',
					`Sec-WebSocket-Key: ${wsKey}`,
					'Sec-WebSocket-Version: 13',
					'Sec-WebSocket-Protocol: v4.channel.k8s.io'
				];
				if (this.token) headers.push(`Authorization: Bearer ${this.token}`);
				headers.push('', '');
				socket.write(headers.join('\r\n'));
			});

			let headerBuf = '';
			let upgraded = false;
			let frameBuffer: Buffer = Buffer.alloc(0);

			const processOneshotFrames = (): Buffer => {
				let buf = frameBuffer;
				while (buf.length >= 2) {
					const opcode = buf[0] & 0x0f;
					const masked = (buf[1] & 0x80) !== 0;
					let payloadLen = buf[1] & 0x7f;
					let offset = 2;

					if (payloadLen === 126) {
						if (buf.length < 4) break;
						payloadLen = buf.readUInt16BE(2); offset = 4;
					} else if (payloadLen === 127) {
						if (buf.length < 10) break;
						payloadLen = buf.readUInt32BE(6); offset = 10;
					}
					if (masked) offset += 4;
					if (buf.length < offset + payloadLen) break;

					const payload = buf.subarray(offset, offset + payloadLen);

					if (opcode === 0x01 || opcode === 0x02) {
						if (payload.length >= 1) {
							const channel = payload[0];
							const text = payload.subarray(1).toString('utf8');
							if (channel === 1) {
								stdout += text; totalBytes += text.length;
							} else if (channel === 2) {
								stderr += text; totalBytes += text.length;
							} else if (channel === 3) {
								try {
									const status = JSON.parse(text);
									if (status.status === 'Failure') {
										done(new Error(status.message || 'Command failed'));
										return Buffer.alloc(0);
									}
								} catch { /* ignore */ }
							}
							if (totalBytes > maxBytes) {
								done(new Error('Output exceeded size limit'));
								return Buffer.alloc(0);
							}
						}
					} else if (opcode === 0x08) {
						done();
						return Buffer.alloc(0);
					}

					buf = buf.subarray(offset + payloadLen);
				}
				return buf;
			};

			socket.on('data', (chunk: Buffer) => {
				if (!upgraded) {
					headerBuf += chunk.toString('binary');
					const headerEnd = headerBuf.indexOf('\r\n\r\n');
					if (headerEnd === -1) return;

					const firstLine = headerBuf.substring(0, headerBuf.indexOf('\r\n'));
					if (!firstLine.includes('101')) {
						const body = headerBuf.substring(headerEnd + 4).slice(0, 500);
						done(new Error(`Exec failed: ${firstLine} — ${body}`));
						return;
					}

					upgraded = true;
					const remaining = Buffer.from(headerBuf.substring(headerEnd + 4), 'binary');
					if (remaining.length > 0) {
						frameBuffer = Buffer.concat([frameBuffer, remaining]);
						frameBuffer = processOneshotFrames();
					}
				} else {
					frameBuffer = Buffer.concat([frameBuffer, chunk]);
					frameBuffer = processOneshotFrames();
				}
			});

			socket.on('close', () => done());
			socket.on('error', (err) => done(err));
		});
	}
}

// ── Exec Types & Helpers ─────────────────────────────────────────────────────

export interface ExecHandle {
	sendStdin(data: string): void;
	sendResize(cols: number, rows: number): void;
	close(): void;
}

/** Process WebSocket frames from exec connection */
function processExecFrames(
	buffer: Buffer,
	opts: {
		shell?: string;
		onData: (channel: number, data: string) => void;
		onClose?: (code?: number, reason?: string) => void;
		onError?: (err: Error) => void;
	},
	handle: ExecHandle,
	socket: net.Socket | tls.TLSSocket
): Buffer {
	while (buffer.length >= 2) {
		const opcode = buffer[0] & 0x0f;
		const masked = (buffer[1] & 0x80) !== 0;
		let payloadLen = buffer[1] & 0x7f;
		let offset = 2;

		if (payloadLen === 126) {
			if (buffer.length < 4) break;
			payloadLen = buffer.readUInt16BE(2);
			offset = 4;
		} else if (payloadLen === 127) {
			if (buffer.length < 10) break;
			payloadLen = buffer.readUInt32BE(6);
			offset = 10;
		}

		if (masked) offset += 4;
		if (buffer.length < offset + payloadLen) break;

		const payload = buffer.subarray(offset, offset + payloadLen);

		if (opcode === 0x01 || opcode === 0x02) {
			// K8s exec data: channel byte + payload
			if (payload.length >= 1) {
				const channel = payload[0];
				const data = payload.subarray(1).toString('utf8');

				if (channel === 1 || channel === 2) {
					if (channel === 2 && isNoShellErrorMessage(data)) {
						opts.onError?.(new Error(formatNoShellError(opts.shell ?? 'sh')));
						buffer = buffer.subarray(offset + payloadLen);
						continue;
					}

					opts.onData(channel, data);
				} else if (channel === 3) {
					// Status channel
					try {
						const status = JSON.parse(data);
						if (status.status === 'Failure') {
							const statusMessage = status.message || 'Exec failed';
							opts.onError?.(
								new Error(
									isNoShellErrorMessage(statusMessage)
										? formatNoShellError(opts.shell ?? 'sh')
										: statusMessage
								)
							);
						} else {
							opts.onClose?.(status.code);
						}
					} catch {
						opts.onClose?.();
					}
				}
			}
		} else if (opcode === 0x08) {
			opts.onClose?.();
			handle.close();
			return Buffer.alloc(0);
		} else if (opcode === 0x09) {
			// Ping → pong
			sendWsFrame(socket, 0x0a, payload);
		}

		buffer = buffer.subarray(offset + payloadLen);
	}
	return buffer;
}

/** Build and send a masked WebSocket frame */
function sendWsFrame(socket: net.Socket | tls.TLSSocket | null, opcode: number, payload: Buffer): void {
	if (!socket || socket.destroyed) return;

	const len = payload.length;
	const maskKey = Buffer.alloc(4);
	for (let i = 0; i < 4; i++) maskKey[i] = Math.floor(Math.random() * 256);

	let header: Buffer;
	if (len < 126) {
		header = Buffer.alloc(6);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | len;
		maskKey.copy(header, 2);
	} else if (len < 65536) {
		header = Buffer.alloc(8);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(len, 2);
		maskKey.copy(header, 4);
	} else {
		header = Buffer.alloc(14);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 127;
		header.writeUInt32BE(0, 2);
		header.writeUInt32BE(len, 6);
		maskKey.copy(header, 10);
	}

	const masked = Buffer.alloc(len);
	for (let i = 0; i < len; i++) {
		masked[i] = payload[i] ^ maskKey[i & 3];
	}

	socket.write(Buffer.concat([header, masked]));
}
