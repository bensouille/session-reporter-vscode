/**
 * Dashboard Helper — VS Code Extension
 *
 * Two responsibilities depending on context:
 *
 * 1. URI Handler (local/UI host):
 *    Handles  vscode://dashboard-helper/open?remote=ALIAS&folder=/path
 *    and opens the folder in a NEW window (forceNewWindow: true), which is
 *    guaranteed to never overwrite an existing session.
 *
 * 2. Workspace Reporter (remote host):
 *    When a workspace is open and dashboardHelper.backendUrl + agentToken are
 *    configured, POSTs the current workspace(s) to the backend so the dashboard
 *    stays in sync without the full agent running.
 *    Uses  POST /api/v1/hosts/session-sync  (lightweight, no system metrics).
 */

import * as vscode from "vscode";
import * as os from "os";
import * as https from "https";
import * as http from "http";

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  // ── 1. URI handler ────────────────────────────────────────────────────────
  // Always registered; VS Code only routes it when the extension is local.
  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri })
  );

  // ── 2. Workspace reporter ─────────────────────────────────────────────────
  // Only meaningful when there are open workspace folders (i.e. on a remote or
  // when a local folder is open). Skipped silently when not configured.
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return;
  }

  const config = vscode.workspace.getConfiguration("dashboardHelper");
  const backendUrl = config.get<string>("backendUrl", "").trim();
  const token = config.get<string>("agentToken", "").trim();

  if (!backendUrl || !token) {
    return; // not configured — skip silently
  }

  const intervalSec = Math.max(
    10,
    config.get<number>("reportInterval", 60)
  );

  // Register all current folders as active immediately
  for (const f of folders) {
    syncSession(backendUrl, token, f, true);
  }

  // Keep in sync when folders are added / removed within the same window
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.added) syncSession(backendUrl, token, f, true);
      for (const f of e.removed) syncSession(backendUrl, token, f, false);
    })
  );

  // Periodic heartbeat so the dashboard knows we're still alive
  const timer = setInterval(() => {
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      syncSession(backendUrl, token, f, true);
    }
  }, intervalSec * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Mark sessions inactive when the window/extension host shuts down
  context.subscriptions.push({
    dispose() {
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        syncSession(backendUrl, token, f, false);
      }
    },
  });
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------
// URI handler — vscode://dashboard-helper/open?remote=ALIAS&folder=PATH
// ---------------------------------------------------------------------------

function handleUri(uri: vscode.Uri): void {
  if (uri.path !== "/open") {
    vscode.window.showErrorMessage(
      `Dashboard Helper: unknown path "${uri.path}"`
    );
    return;
  }

  const params = new URLSearchParams(uri.query);
  const folder = params.get("folder") ?? undefined;
  const remote = params.get("remote") ?? undefined;

  if (!folder && !remote) {
    vscode.window.showErrorMessage(
      "Dashboard Helper: at least one of 'folder' or 'remote' is required"
    );
    return;
  }

  let targetUri: vscode.Uri;

  if (remote) {
    // Remote SSH workspace — folder defaults to "/" when not provided
    const remotePath = folder || "/";
    targetUri = vscode.Uri.parse(
      `vscode-remote://ssh-remote+${remote}${remotePath}`
    );
  } else if (folder) {
    // Local workspace
    targetUri = vscode.Uri.file(folder);
  } else {
    vscode.window.showErrorMessage("dashboard-helper: missing folder parameter");
    return;
  }

  // forceNewWindow: true — never overwrites an existing open session
  vscode.commands.executeCommand("vscode.openFolder", targetUri, {
    forceNewWindow: true,
  });
}

// ---------------------------------------------------------------------------
// Workspace reporter
// ---------------------------------------------------------------------------

function syncSession(
  backendUrl: string,
  token: string,
  folder: vscode.WorkspaceFolder,
  isActive: boolean
): void {
  const config = vscode.workspace.getConfiguration("dashboardHelper");
  const hostname =
    config.get<string>("hostAlias", "").trim() || os.hostname();

  const repo = folder.uri.scheme === "file"
    ? folder.uri.fsPath
    : folder.uri.path;

  // Generate the canonical URL pointing back to this extension's URI handler
  const vscodeUrl =
    `vscode://dashboard-helper/open` +
    `?remote=${encodeURIComponent(hostname)}` +
    `&folder=${encodeURIComponent(repo)}`;

  const payload = JSON.stringify({
    hostname,
    repo,
    vscode_url: vscodeUrl,
    is_active: isActive,
  });

  postJson(
    `${backendUrl.replace(/\/$/, "")}/api/v1/hosts/session-sync`,
    token,
    payload
  );
}

function postJson(endpoint: string, token: string, payload: string): void {
  try {
    const parsed = new URL(endpoint);
    const isHttps = parsed.protocol === "https:";
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : isHttps ? 443 : 80;

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Token": token,
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options);
    req.on("error", () => {}); // silent — must not disrupt IDE workflow
    req.write(payload);
    req.end();
  } catch {
    // silent
  }
}
