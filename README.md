# Dashboard Helper — VS Code Extension

Companion extension for the [personal developer dashboard](https://github.com/steph/dashboard).

## Features

### 1. URI Handler — open remote folders in a new window

Handles `vscode://dashboard-helper/open` URIs emitted by the dashboard frontend. Uses `vscode.openFolder` with `forceNewWindow: true` — **guaranteed** to never overwrite an existing open session.

**URL format:**

```
# Remote SSH workspace (most common)
vscode://dashboard-helper/open?remote=HOST_ALIAS&folder=/absolute/path

# Local workspace
vscode://dashboard-helper/open?folder=/absolute/path

# Remote host only (no folder — opens connection root)
vscode://dashboard-helper/open?remote=HOST_ALIAS
```

The `remote` parameter is the SSH config alias as defined in `~/.ssh/config` on your local machine.

### 2. Workspace Reporter — sync active sessions to the dashboard

When `dashboardHelper.backendUrl` and `dashboardHelper.agentToken` are configured (typically in remote workspace settings), the extension:

- Reports the current workspace as **active** on startup
- Marks it **inactive** when the window closes
- Sends a heartbeat every 60 seconds

This is a lightweight complement to the `agent.py` script — no system metrics, just session tracking.

## Installation

```bash
npm install
npm run compile
npm run package          # produces dashboard-helper-0.1.0.vsix
```

In VS Code: **Extensions → ⋯ → Install from VSIX…**

Or via CLI:
```bash
code --install-extension dashboard-helper-0.1.0.vsix
```

## Configuration

| Setting | Default | Description |
|---|---|---|
| `dashboardHelper.backendUrl` | `""` | Dashboard backend URL, e.g. `https://dashboard.example.com` |
| `dashboardHelper.agentToken` | `""` | `AGENT_TOKEN` value from the backend `.env` |
| `dashboardHelper.hostAlias` | `""` | SSH alias for this host (defaults to system hostname) |
| `dashboardHelper.reportInterval` | `60` | Heartbeat interval in seconds |

The URI handler works without any configuration. The workspace reporter only activates when both `backendUrl` and `agentToken` are set.

### Typical setup on a remote host

Add to the remote workspace's `.vscode/settings.json` (or remote user settings):

```json
{
  "dashboardHelper.backendUrl": "https://dashboard.example.com",
  "dashboardHelper.agentToken": "your-32-byte-hex-token",
  "dashboardHelper.hostAlias": "MiniPC"
}
```

## Backend API

The extension calls one endpoint on the dashboard backend:

```
POST /api/v1/hosts/session-sync
X-Agent-Token: <token>
Content-Type: application/json

{
  "hostname": "MiniPC",
  "repo": "/home/steph/myproject",
  "vscode_url": "vscode://dashboard-helper/open?remote=MiniPC&folder=%2Fhome%2Fsteph%2Fmyproject",
  "is_active": true
}
```

## Architecture note

This extension has **two deployment contexts**:

| Context | Where it runs | What it does |
|---|---|---|
| Local machine | VS Code UI process | Handles `vscode://` URIs, opens remote folders |
| Remote host | VS Code extension host | Reports active workspaces to backend |

Both can run simultaneously: install once on your local machine, and the same `.vsix` installed on each remote will activate the reporter there too.
