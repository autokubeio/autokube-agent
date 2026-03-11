/**
 * AutoKube Agent — In-Cluster Kubernetes Bridge
 *
 * This agent runs inside a Kubernetes cluster and establishes a persistent
 * WebSocket connection back to the AutoKube dashboard. It acts as a
 * reverse proxy: AutoKube sends K8s API request messages through the
 * WebSocket, and the agent executes them against the local cluster API
 * using its ServiceAccount token, then returns the responses.
 *
 * Environment / CLI flags:
 *   --url  / AUTOKUBE_URL   — AutoKube dashboard URL (e.g. http://localhost:5173)
 *   --token / AUTOKUBE_TOKEN — Agent authentication token
 */

import { AgentWsClient } from './ws-client';
import { K8sClient } from './k8s-client';
import { parseArgs } from './args';
import { version } from '../package.json';

async function main() {
	const banner = `AutoKube Agent v${version}`;
	const padded = banner.padEnd(40, ' ');
	console.log('╔══════════════════════════════════════════╗');
	console.log(`║  ${padded}║`);
	console.log('╚══════════════════════════════════════════╝');

	const config = parseArgs();

	console.log(`[agent] AutoKube URL : ${config.url}`);
	console.log(`[agent] Token        : ${config.token.slice(0, 20)}...`);

	// Initialise the in-cluster Kubernetes client
	const k8s = new K8sClient();
	await k8s.init();
	console.log(`[agent] K8s API      : ${k8s.apiServer}`);

	// Start the WebSocket connection
	const client = new AgentWsClient(config.url, config.token, k8s);
	client.start();

	// Graceful shutdown
	const shutdown = () => {
		console.log('\n[agent] Shutting down…');
		client.stop();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((err) => {
	console.error('[agent] Fatal error:', err);
	process.exit(1);
});
