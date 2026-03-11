# AutoKube Agent

In-cluster Kubernetes agent that connects your cluster to the [AutoKube](https://github.com/autokubeio/autokube) dashboard via a persistent reverse WebSocket connection.

## How It Works

The AutoKube Agent runs as a Deployment inside your Kubernetes cluster and dials out to the AutoKube dashboard over a **persistent WebSocket** connection (`ws(s)://<url>/api/agent/ws`). Because the connection is initiated from within the cluster, no ingress or firewall rules are required — the agent reaches the dashboard the same way a browser would.

Once connected, the dashboard sends JSON messages through the socket describing Kubernetes API calls it wants to make. The agent executes each request against the local API server using its **ServiceAccount token** (no kubeconfig needed), then streams the response back. This makes the agent a transparent, authenticated reverse proxy between AutoKube and the cluster API.

Beyond plain API proxying, the agent also handles **interactive terminal sessions**: when the dashboard sends an `exec-start` message, the agent opens a native Kubernetes exec WebSocket to the target pod and relays stdin, stdout, and stderr in real time. A lighter-weight **one-shot exec** path is also available for non-interactive commands.

If the WebSocket connection drops for any reason, the agent automatically reconnects using exponential backoff (starting at 1 s, capping at 30 s). The agent has **zero external dependencies** — all networking uses Bun's built-in `fetch` and `node:https`.

## WebSocket Protocol

The agent connects to `ws(s)://<url>/api/agent/ws?token=<token>`.  
Before connecting it optionally calls `GET /api/agent/discover` to let the dashboard redirect it to a different WebSocket endpoint.

### Message types (dashboard → agent)

| Type | Description |
|------|-------------|
| `k8s-request` | Execute a Kubernetes API request (`path`, `method`, `body`, `headers`, `timeout`) |
| `exec-start` | Open an interactive terminal session in a pod (`namespace`, `pod`, `container`, `shell`, `cols`, `rows`) |
| `exec-stdin` | Send stdin data to an active exec session (`sessionId`, `data`) |
| `exec-resize` | Resize the terminal (`sessionId`, `cols`, `rows`) |
| `exec-close` | Close an exec session (`sessionId`) |
| `exec-oneshot` | Run a command without TTY and return output (`namespace`, `pod`, `container`, `command[]`, `maxBytes`, `timeout`) |
| `ping` | Keepalive ping (agent replies with `pong`) |

### Message types (agent → dashboard)

| Type | Description |
|------|-------------|
| `k8s-response` | Kubernetes API response (`id`, `status`, `body`, `headers`) |
| `exec-started` | Exec session opened (`id`, `sessionId`) |
| `exec-output` | Terminal output (`sessionId`, `channel`, `data`) |
| `exec-closed` | Exec session ended (`sessionId`, `code`, `reason`) |
| `exec-error` | Exec session failed to start (`id`, `error`) |
| `exec-oneshot-result` | One-shot result (`id`, `stdout`, `stderr`) |
| `exec-oneshot-error` | One-shot failure (`id`, `error`) |

### Run Locally (Development)

```bash
# Terminal 1: Start kubectl proxy
kubectl proxy --port=8001

# Terminal 2: Run the agent
bun install
bun run dev --url http://localhost:5173 --token autokube_agent_token_xxxxx
```

## Project Structure

```
autokube-agent/
├── src/
│   ├── index.ts          # Entry point — wires up K8sClient + AgentWsClient
│   ├── args.ts           # CLI/env config parser
│   ├── k8s-client.ts     # In-cluster K8s API client (exec, oneshot, request)
│   └── ws-client.ts      # Persistent WebSocket client to AutoKube
├── Dockerfile
└── package.json
```

## Building the Docker Image

```bash
docker build -t autokube-agent:latest .
```

## License

MIT
