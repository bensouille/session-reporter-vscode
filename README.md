# Session Reporter — VS Code Extension

A VS Code extension with two independent features:

1. **URI Handler** — opens any remote SSH folder or local workspace in a VS Code window via a `vscode://remote.session-reporter/open` link, smartly focusing an existing window instead of opening a new one when the workspace is already open.
2. **Workspace Reporter** — automatically reports your active VS Code sessions (hostname + open folder paths) to a configurable backend, so a dashboard or any external tool can stay in sync with what you have open.

---

## Features

### 1. URI Handler — open any remote folder from a link

Handles `vscode://remote.session-reporter/open` URIs (extension ID: `remote.session-reporter`).

**URL format:**

```
# Remote SSH workspace
vscode://remote.session-reporter/open?remote=my-server&folder=/home/user/myproject

# Local workspace
vscode://remote.session-reporter/open?folder=/absolute/path

# Remote host root (no specific folder)
vscode://remote.session-reporter/open?remote=my-server
```

The `remote` parameter is an SSH config alias defined in `~/.ssh/config` on your **local** machine. No additional configuration is required for the URI handler to work.

**Smart window management:**

- If the target workspace is **already open** in a window, that window is **focused** (no new window opened, no popup).
- If not open yet, a **new window** is opened (`forceNewWindow: true`), avoiding the *"save workspace configuration?"* prompt that appears when VS Code tries to replace the current window.

The extension achieves this by:
1. Scanning `workspaceStorage` to resolve the exact VS Code SSH authority for the target host — supporting both the plain format (`ssh-remote+hostname`) and VS Code's newer hex-encoded JSON format (`ssh-remote+7b22...7d`).
2. Reading `storage.json` at runtime to check which windows are currently open.

### 2. Workspace Reporter — report active sessions to a backend

When `sessionReporter.backendUrl` and `sessionReporter.agentToken` are set (typically in remote workspace settings), the extension:

- Reports the current workspace as **active** on startup
- Tracks workspace folder additions and removals within the same window
- Marks all workspaces **inactive** when the window closes
- Sends a heartbeat at a configurable interval (default: 60 s)

The `vscode://` URL embedded in each report includes `sshUser@hostname` if `sessionReporter.sshUser` is set, so the dashboard generates links that preserve Copilot Chat history (VS Code ties chat history to the workspace URI, which includes the SSH user).

This is a lightweight alternative to running the full `agent.py` — no system metrics, just session tracking.

---

## Data collected (GDPR)

When the workspace reporter is active, the extension transmits the following data to the backend URL **you configured**:

- **Hostname** of the remote machine (`hostAlias` setting, or system hostname)
- **Folder paths** of open workspaces
- Active/inactive status and timestamp

No data is sent to any third party. You are the sole operator of the backend.

---

## Installation

### Prerequisites

- VS Code 1.74+
- A backend that accepts `POST /api/v1/hosts/session-sync` (for the reporter feature only)

### Build from source

```bash
git clone https://github.com/bensouille/dashboard-helper-vscode.git
cd dashboard-helper-vscode
npm install
npm run compile
npm run package          # → session-reporter-0.2.0.vsix
```

### Install the `.vsix`

**Via VS Code UI:** Extensions panel → `⋯` menu → *Install from VSIX…*

**Via CLI (local machine):**
```bash
code --install-extension session-reporter-0.2.0.vsix
```

**Via CLI (SSH remote host):**
```bash
code --install-extension session-reporter-0.2.0.vsix
# or, from the remote machine directly:
code-server --install-extension session-reporter-0.2.0.vsix
```

Install on **both** your local machine (for the URI handler) and every remote host (for session reporting).

---

## Configuration

All settings live under the `sessionReporter` namespace.

| Setting | Default | Description |
|---|---|---|
| `sessionReporter.backendUrl` | `""` | URL of your backend, e.g. `https://dashboard.example.com` |
| `sessionReporter.agentToken` | `""` | Secret token matching `AGENT_TOKEN` in the backend `.env` |
| `sessionReporter.hostAlias` | `""` | Identifier for this host (defaults to system hostname) |
| `sessionReporter.sshUser` | `""` | SSH user used to connect to this host (e.g. `root`). Included in the generated `vscode://` URL as `user@host` so VS Code workspace identity and Copilot Chat history are preserved. |
| `sessionReporter.reportInterval` | `60` | Heartbeat interval in seconds (min: 10) |

> The URI handler works **without any configuration**. The workspace reporter only activates when `backendUrl` and `agentToken` are both set.

### Setup on a remote host

Add to the remote workspace `.vscode/settings.json` or remote user settings:

```json
{
  "sessionReporter.backendUrl": "https://dashboard.example.com",
  "sessionReporter.agentToken": "your-secret-token",
  "sessionReporter.hostAlias": "my-server",
  "sessionReporter.sshUser": "steph"
}
```

`hostAlias` should match the SSH `Host` alias you use in `~/.ssh/config` so that the dashboard can generate correct `vscode://` links back to this host.
`sshUser` must match the user you use when connecting via Remote SSH (e.g. `User steph` in `~/.ssh/config`).

### Multi-host setup

Install the same `.vsix` on every remote host. Each host reports independently using its own `hostAlias`. The backend deduplicates sessions by `(hostname, repo)`.

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
  "vscode_url": "vscode://remote.session-reporter/open?remote=steph%40my-server&folder=%2Fhome%2Fuser%2Fmyproject",
  "is_active": true
}
```

- `hostname` is `hostAlias` (or system hostname).
- `vscode_url` encodes `sshUser@hostname` in the `remote` parameter when `sshUser` is set. The backend will **not overwrite** an existing URL already stored for this session.
- Setting `is_active: false` marks the session as closed (sent automatically on window/extension deactivation).

---

## Debugging

All activity is logged to the **Session Reporter** output channel (View → Output → Session Reporter). Useful for diagnosing:

- Authority resolution (plain hostname vs hex-encoded JSON)
- Whether a window was found open in `storage.json`
- POST request results

---

## Development

```bash
npm run watch    # recompile on save
```

Press `F5` in VS Code to launch an Extension Development Host for live debugging.

---

## License

MIT

