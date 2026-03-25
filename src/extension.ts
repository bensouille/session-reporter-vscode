/**
 * Dashboard Helper — VS Code Extension
 *
 * Two responsibilities dispatched by extensionKind:
 *
 * 1. URI Handler  [extensionKind = UI]  — runs on the LOCAL client (Windows)
 *    Handles  vscode://devdashboard.dashboard-helper/open?remote=ALIAS&folder=/path
 *    and opens the workspace in a NEW window (forceNewWindow: true).
 *
 * 2. Workspace Reporter  [extensionKind = Workspace]  — runs on the REMOTE host (Linux)
 *    Detects open workspaceFolders and POSTs them to the backend so the
 *    dashboard stays in sync.  Uses POST /api/v1/hosts/session-sync.
 */

import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

let log: vscode.OutputChannel;
let globalStoragePath: string;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel("Dashboard Helper");
  context.subscriptions.push(log);

  // Store for workspaceStorage scanning (UI side)
  globalStoragePath = context.globalStorageUri.fsPath;

  const kind = context.extension.extensionKind;
  const kindLabel = kind === vscode.ExtensionKind.UI ? "UI (local)" : "Workspace (remote)";
  log.appendLine(`[activate] running as ${kindLabel}`);

  if (kind === vscode.ExtensionKind.UI) {
    // ── URI handler — local client only ─────────────────────────────────────
    context.subscriptions.push(
      vscode.window.registerUriHandler({ handleUri })
    );
    log.appendLine("[activate] URI handler registered → vscode://devdashboard.dashboard-helper/open");
  } else {
    // ── Workspace reporter — remote host only ────────────────────────────────
    startReporter(context);
  }
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------
// URI handler — vscode://devdashboard.dashboard-helper/open?remote=ALIAS&folder=PATH
// ---------------------------------------------------------------------------

/**
 * Scan local workspaceStorage to find the exact SSH authority VS Code used
 * for a given remote host + folder.  Returns the authority portion after
 * "ssh-remote+" (which may be a plain hostname or a hex-encoded JSON blob).
 */
function findStoredAuthority(remote: string, remotePath: string): string | null {
  try {
    // globalStoragePath = .../Code/User/globalStorage/devdashboard.dashboard-helper
    // target            = .../Code/User/workspaceStorage/
    const userDir = path.dirname(path.dirname(globalStoragePath));
    const wsStoragePath = path.join(userDir, "workspaceStorage");

    if (!fs.existsSync(wsStoragePath)) {
      log.appendLine(`[findStoredAuthority] workspaceStorage not found at ${wsStoragePath}`);
      return null;
    }

    const normTarget = remotePath.replace(/\/+$/, "") || "/";
    const entries = fs.readdirSync(wsStoragePath);

    for (const entry of entries) {
      const wsJsonPath = path.join(wsStoragePath, entry, "workspace.json");
      if (!fs.existsSync(wsJsonPath)) { continue; }

      try {
        const content = JSON.parse(fs.readFileSync(wsJsonPath, "utf-8"));
        const folderUri = content.folder as string | undefined;
        if (!folderUri) { continue; }

        const parsed = vscode.Uri.parse(folderUri);
        if (parsed.scheme !== "vscode-remote") { continue; }
        if (!parsed.authority.startsWith("ssh-remote+")) { continue; }

        // Compare folder path (normalise trailing slashes)
        const storedPath = parsed.path.replace(/\/+$/, "") || "/";
        if (storedPath !== normTarget) { continue; }

        const authority = parsed.authority.substring("ssh-remote+".length);

        // Plain match: authority === remote hostname
        if (authority === remote) {
          log.appendLine(`[findStoredAuthority] plain match: ${authority}`);
          return authority;
        }

        // Hex-encoded JSON match: {"hostName":"MiniPC"} → hex
        try {
          const decoded = Buffer.from(authority, "hex").toString("utf-8");
          const json = JSON.parse(decoded);
          if (json.hostName === remote) {
            log.appendLine(`[findStoredAuthority] hex match: ${authority}`);
            return authority;
          }
        } catch {
          // not hex — skip
        }
      } catch {
        // corrupt workspace.json — skip
      }
    }

    log.appendLine(`[findStoredAuthority] no match for remote=${remote} path=${normTarget}`);
    return null;
  } catch (e) {
    log.appendLine(`[findStoredAuthority] error scanning: ${e}`);
    return null;
  }
}

function handleUri(uri: vscode.Uri): void {
  log.appendLine(`[handleUri] received: ${uri.toString()}`);

  if (uri.path !== "/open") {
    const msg = `Dashboard Helper: unknown path "${uri.path}"`;
    log.appendLine(`[handleUri] error: ${msg}`);
    vscode.window.showErrorMessage(msg);
    return;
  }

  const params = new URLSearchParams(uri.query);
  const folder = params.get("folder") ?? undefined;
  const remote = params.get("remote") ?? undefined;

  log.appendLine(`[handleUri] remote=${remote} folder=${folder}`);

  if (!folder && !remote) {
    const msg = "Dashboard Helper: at least one of 'folder' or 'remote' is required";
    log.appendLine(`[handleUri] error: ${msg}`);
    vscode.window.showErrorMessage(msg);
    return;
  }

  let targetUri: vscode.Uri;

  if (remote) {
    const remotePath = folder || "/";

    // Find the exact authority from local workspaceStorage.
    // This handles both the plain format (ssh-remote+hostname) and the newer
    // hex-encoded JSON format (ssh-remote+7b22...7d) automatically.
    const storedAuthority = findStoredAuthority(remote, remotePath);

    if (storedAuthority) {
      const raw = `vscode-remote://ssh-remote+${storedAuthority}${remotePath}`;
      log.appendLine(`[handleUri] using stored authority: ${raw}`);
      targetUri = vscode.Uri.parse(raw);
    } else {
      // Fallback: plain hostname (works for older connections)
      const raw = `vscode-remote://ssh-remote+${remote}${remotePath}`;
      log.appendLine(`[handleUri] no stored authority, using plain: ${raw}`);
      targetUri = vscode.Uri.parse(raw);
    }

    // If current window already has this workspace, nothing to do
    const allFolders = vscode.workspace.workspaceFolders ?? [];
    if (allFolders.some(f => f.uri.toString() === targetUri.toString())) {
      log.appendLine("[handleUri] current window already matches target — no-op");
      return;
    }

    // forceNewWindow: false → VS Code scans all open windows for a matching
    // workspace URI and focuses that window.  If no match exists, it opens the
    // folder in the current window (acceptable when switching from the browser).
    log.appendLine(`[handleUri] openFolder with forceNewWindow=false`);
    vscode.commands.executeCommand("vscode.openFolder", targetUri, {
      forceNewWindow: false,
    }).then(
      () => log.appendLine("[handleUri] openFolder executed"),
      (err) => {
        log.appendLine(`[handleUri] openFolder error: ${err}`);
        vscode.window.showErrorMessage(`Dashboard Helper: failed to open folder — ${err}`);
      }
    );
    return;
  } else if (folder) {
    log.appendLine(`[handleUri] opening local folder: ${folder}`);
    targetUri = vscode.Uri.file(folder);
  } else {
    vscode.window.showErrorMessage("dashboard-helper: missing folder parameter");
    return;
  }

  log.appendLine(`[handleUri] openFolder with forceNewWindow=false`);
  vscode.commands.executeCommand("vscode.openFolder", targetUri, {
    forceNewWindow: false,
  }).then(
    () => log.appendLine("[handleUri] openFolder command executed"),
    (err) => {
      log.appendLine(`[handleUri] openFolder error: ${err}`);
      vscode.window.showErrorMessage(`Dashboard Helper: failed to open folder — ${err}`);
    }
  );
}

// ---------------------------------------------------------------------------
// Workspace reporter — runs on the REMOTE host (extensionKind = Workspace)
// ---------------------------------------------------------------------------

function startReporter(context: vscode.ExtensionContext): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    log.appendLine("[reporter] no workspace folders open — skipping");
    return;
  }

  const config = vscode.workspace.getConfiguration("dashboardHelper");
  const backendUrl = config.get<string>("backendUrl", "").trim();
  const token = config.get<string>("agentToken", "").trim();

  if (!backendUrl || !token) {
    log.appendLine("[reporter] backendUrl or agentToken not configured — skipping");
    return;
  }

  const intervalSec = Math.max(10, config.get<number>("reportInterval", 60));
  log.appendLine(`[reporter] starting — backend=${backendUrl} interval=${intervalSec}s`);

  // Report all current folders as active immediately
  for (const f of folders) {
    syncSession(backendUrl, token, f, true);
  }

  // Track folder changes within the same window
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.added) syncSession(backendUrl, token, f, true);
      for (const f of e.removed) syncSession(backendUrl, token, f, false);
    })
  );

  // Periodic heartbeat
  const timer = setInterval(() => {
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      syncSession(backendUrl, token, f, true);
    }
  }, intervalSec * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Mark inactive on shutdown
  context.subscriptions.push({
    dispose() {
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        syncSession(backendUrl, token, f, false);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Workspace reporter helpers
// ---------------------------------------------------------------------------

function syncSession(
  backendUrl: string,
  token: string,
  folder: vscode.WorkspaceFolder,
  isActive: boolean
): void {
  const config = vscode.workspace.getConfiguration("dashboardHelper");

  const repo = folder.uri.scheme === "file"
    ? folder.uri.fsPath
    : folder.uri.path;

  // hostname for the checkin payload (bare machine name, no user)
  const hostname = config.get<string>("hostAlias", "").trim() || os.hostname();

  // Build the remote authority for the vscode:// URL.
  // When running as Workspace (on the remote host), folder.uri.scheme is "file"
  // and we only know the bare hostname.  The sshUser setting lets the admin specify
  // the SSH user so the generated URL matches VS Code's workspace storage hash.
  // Priority: explicit sshUser setting > bare hostname (backend will not overwrite
  // an existing URL that already contains user@host).
  const sshUser = config.get<string>("sshUser", "").trim();
  const remote = sshUser ? `${sshUser}@${hostname}` : hostname;

  // Generate the canonical URL — remote must match the SSH authority exactly
  const vscodeUrl =
    `vscode://devdashboard.dashboard-helper/open` +
    `?remote=${encodeURIComponent(remote)}` +
    `&folder=${encodeURIComponent(repo)}`;

  log.appendLine(`[syncSession] remote=${remote} repo=${repo} active=${isActive}`);

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
