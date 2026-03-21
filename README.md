# Dashboard Helper — VS Code Extension

A companion VS Code extension for [self-hosted developer dashboards](https://github.com/bensouille/dashboard-helper-vscode). It does two things:

1. **URI Handler** — opens remote SSH folders in a **new** VS Code window via `vscode://dashboard-helper/open` links
2. **Workspace Reporter** — automatically syncs your active VS Code sessions to the dashboard backend

---

## Features

### 1. URI Handler — open any remote folder in a new window

Handles `vscode://dashboard-helper/open` URIs. Uses `vscode.openFolder` with `forceNewWindow: true`, so it **never** overwrites an existing open session.

**URL format:**

```
# Remote SSH workspace
vscode://dashboard-helper/open?remote=my-server&folder=/home/user/myproject

# Local workspace
vscode://dashboard-helper/open?folder=/absolute/path

# Remote host root (no specific folder)
vscode://dashboard-helper/open?remote=my-server
```

The `remote` parameter is an SSH config alias defined in `~/.ssh/config` on your **local** machine. No additional configuration is required for the URI handler to work.

### 2. Workspace Reporter — keep the dashboard in sync

When `dashboardHelper.backendUrl` and `dashboardHelper.agentToken` are set (typically in remote workspace settings), the extension:

- Reports the current workspace as **active** on startup
- Marks it **inactive** when the window closes
- Sends a heartbeat at a configurable interval (default: 60 s)

This is a lightweight alternative to running the full `agent.py` — no system metrics, just session tracking.

---

## Installation

### Prerequisites

- VS Code 1.74+
- A running instance of the [developer dashboard backend](https://github.com/bensouille/dashboard-helper-vscode) (for the reporter feature only)

### Build from source

```bash
git clone https://github.com/bensouille/dashboard-helper-vscode.git
cd dashboard-helper-vscode
npm install
npm run compile
npm run package          # → dashboard-helper-0.1.0.vsix
```

### Install the `.vsix`

**Via VS Code UI:** Extensions panel → `⋯` menu → *Install from VSIX…*

**Via CLI (local machine):**
```bash
code --install-extension dashboard-helper-0.1.0.vsix
```

**Via CLI (SSH remote host):**
```bash
code --install-extension dashboard-helper-0.1.0.vsix
# or, from the remote machine directly:
code-server --install-extension dashboard-helper-0.1.0.vsix
```

Install on **both** your local machine (for the URI handler) and every remote host (for session reporting).

---

## Configuration

All settings live under the `dashboardHelper` namespace.

| Setting | Default | Description |
|---|---|---|
| `dashboardHelper.backendUrl` | `""` | URL of your dashboard backend, e.g. `https://dashboard.example.com` |
| `dashboardHelper.agentToken` | `""` | Secret token matching `AGENT_TOKEN` in the backend `.env` |
| `dashboardHelper.hostAlias` | `""` | Identifier for this host (defaults to system hostname) |
| `dashboardHelper.reportInterval` | `60` | Heartbeat interval in seconds (min: 10) |

> The URI handler works **without any configuration**. The workspace reporter only activates when `backendUrl` and `agentToken` are both set.

### Setup on a remote host

Add to the remote workspace `.vscode/settings.json` or remote user settings:

```json
{
  "dashboardHelper.backendUrl": "https://dashboard.example.com",
  "dashboardHelper.agentToken": "your-secret-token",
  "dashboardHelper.hostAlias": "my-server"
}
```

`hostAlias` should match the SSH `Host` alias you use in `~/.ssh/config` so that the dashboard can generate correct `vscode://` links back to this host.

### Multi-host setup

Install the same `.vsix` on every remote host. Each host reports independently using its own `hostAlias`. The dashboard backend deduplicates sessions by `(hostname, repo)`.

```
Local machine      →  URI handler active  (opens remote windows from dashboard links)
Remote host A      →  Workspace reporter active
Remote host B      →  Workspace reporter active
...
```

---

## Backend API

The extension calls one endpoint:

```
POST /api/v1/hosts/session-sync
X-Agent-Token: <your-token>
Content-Type: application/json

{
  "hostname": "my-server",
  "repo": "/home/user/myproject",
  "vscode_url": "vscode://dashboard-helper/open?remote=my-server&folder=%2Fhome%2Fuser%2Fmyproject",
  "is_active": true
}
```

Setting `is_active: false` marks the session as closed (sent automatically on window/extension deactivation).

---

## Development

```bash
npm run watch    # recompile on save
```

Press `F5` in VS Code to launch an Extension Development Host for live debugging.

---

## License

MIT

