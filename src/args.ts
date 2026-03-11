/**
 * CLI argument & environment variable parser
 */

export interface AgentConfig {
	url: string;
	token: string;
}

export function parseArgs(): AgentConfig {
	const args = process.argv.slice(2);

	let url = process.env.AUTOKUBE_URL ?? '';
	let token = process.env.AUTOKUBE_TOKEN ?? '';

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--url' && args[i + 1]) {
			url = args[++i];
		} else if (args[i] === '--token' && args[i + 1]) {
			token = args[++i];
		}
	}

	if (!url) {
		console.error('[agent] ERROR: --url or AUTOKUBE_URL is required');
		process.exit(1);
	}
	if (!token) {
		console.error('[agent] ERROR: --token or AUTOKUBE_TOKEN is required');
		process.exit(1);
	}

	// Strip trailing slash
	url = url.replace(/\/+$/, '');

	return { url, token };
}
