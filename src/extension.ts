/**
 * Session Reporter — VS Code Extension
 *
 * Two responsibilities dispatched by extensionKind:
 *
 * 1. URI Handler  [extensionKind = UI]  — runs on the LOCAL client (Windows)
 *    Handles  vscode://remote.session-reporter/open?remote=ALIAS&folder=/path
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
  log = vscode.window.createOutputChannel("Session Reporter");
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
    log.appendLine("[activate] URI handler registered → vscode://remote.session-reporter/open");
  } else {
    // ── Workspace reporter — remote host only ────────────────────────────────
    startReporter(context);
  }
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------
// URI handler — vscode://remote.session-reporter/open?remote=ALIAS&folder=PATH
// ---------------------------------------------------------------------------

/**
 * Scan local workspaceStorage to find the exact SSH authority VS Code used
 * for a given remote host + folder.  Returns the authority portion after
 * "ssh-remote+" (which may be a plain hostname or a hex-encoded JSON blob).
 */
/**
 * Returns true if `authority` (the part after "ssh-remote+") corresponds to
 * a given remote hostname, supporting both plain ("MiniPC") and hex-JSON
 * ('{"hostName":"MiniPC"}' → hex) formats.
 */
function authorityMatchesRemote(authority: string, remote: string): boolean {
  if (authority === remote) { return true; }
  try {
    const json = JSON.parse(Buffer.from(authority, "hex").toString("utf-8"));
    return json.hostName === remote;
  } catch {
    return false;
  }
}

function findStoredAuthority(remote: string, remotePath: string): string | null {
  try {
    // globalStoragePath = .../Code/User/globalStorage/remote.session-reporter
    // target            = .../Code/User/workspaceStorage/
    const userDir = path.dirname(path.dirname(globalStoragePath));
    const wsStoragePath = path.join(userDir, "workspaceStorage");

    if (!fs.existsSync(wsStoragePath)) {
      log.appendLine(`[findStoredAuthority] workspaceStorage not found at ${wsStoragePath}`);
      return null;
    }

    const normTarget = remotePath.replace(/\/+$/, "") || "/";
    const entries = fs.readdirSync(wsStoragePath);

    // Collect all parsed entries for this remote so we can fallback to any of
    // them when no exact path match exists (e.g. planning-vue3 was never opened
    // directly from Windows, but dashboard on the same host was).
    let fallbackAuthority: string | null = null;

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

        const authority = parsed.authority.substring("ssh-remote+".length);
        if (!authorityMatchesRemote(authority, remote)) { continue; }

        // Keep first matching authority as fallback (in case no path matches)
        if (!fallbackAuthority) {
          fallbackAuthority = authority;
        }

        // Compare folder path (normalise trailing slashes)
        const storedPath = parsed.path.replace(/\/+$/, "") || "/";
        if (storedPath !== normTarget) { continue; }

        log.appendLine(`[findStoredAuthority] exact match: ${authority} for path ${normTarget}`);
        return authority;
      } catch {
        // corrupt workspace.json — skip
      }
    }

    // No exact path match found.  If we found at least one entry for this
    // remote (e.g. MiniPC/dashboard), reuse its authority format so we build
    // the correct URI (hex) rather than falling back to the plain hostname.
    if (fallbackAuthority) {
      log.appendLine(`[findStoredAuthority] no path match, using same-host authority: ${fallbackAuthority} for ${remote}${normTarget}`);
      return fallbackAuthority;
    }

    log.appendLine(`[findStoredAuthority] no entry found for remote=${remote}`);
    return null;
  } catch (e) {
    log.appendLine(`[findStoredAuthority] error scanning: ${e}`);
    return null;
  }
}

/**
 * Check VS Code's storage.json to see if any window currently has the target
 * URI open.  VS Code writes this file in real-time when windows open/close, so
 * it reliably reflects the current set of open windows.
 *
 * Returns true  → window is open  → use forceNewWindow: false (focus it)
 * Returns false → window not open → use forceNewWindow: true  (new window, no popup)
 */
function countOpenWindows(): number {
  try {
    const userDir = path.dirname(path.dirname(globalStoragePath));
    const codeDir = path.dirname(userDir);
    const storagePath = path.join(codeDir, "storage.json");
    if (!fs.existsSync(storagePath)) { return 0; }
    const storage = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
    const ws: Record<string, unknown> = storage.windowsState ?? {};
    const opened = Array.isArray(ws.openedWindows) ? ws.openedWindows.length : 0;
    const hasLast = ws.lastActiveWindow ? 1 : 0;
    return opened + hasLast;
  } catch {
    return 0;
  }
}

function isWindowCurrentlyOpen(targetUri: vscode.Uri): boolean {
  try {
    // globalStoragePath = .../Code/User/globalStorage/remote.session-reporter
    // codeDir           = .../Code/
    const userDir = path.dirname(path.dirname(globalStoragePath));
    const codeDir = path.dirname(userDir);
    const storagePath = path.join(codeDir, "storage.json");

    if (!fs.existsSync(storagePath)) {
      log.appendLine(`[isWindowCurrentlyOpen] storage.json not found at ${storagePath} — assuming not open`);
      return false;
    }

    const storage = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
    const ws: Record<string, unknown> = storage.windowsState ?? {};
    const openedWindows: unknown[] = [
      ...(Array.isArray(ws.openedWindows) ? ws.openedWindows : []),
      ...(ws.lastActiveWindow ? [ws.lastActiveWindow] : []),
    ];

    const targetStr = targetUri.toString();
    for (const win of openedWindows) {
      const w = win as Record<string, unknown>;
      if (typeof w.folderUri === "string" && w.folderUri === targetStr) {
        log.appendLine(`[isWindowCurrentlyOpen] match found: ${w.folderUri}`);
        return true;
      }
    }

    log.appendLine(`[isWindowCurrentlyOpen] no window open for ${targetStr}`);
    return false;
  } catch (e) {
    log.appendLine(`[isWindowCurrentlyOpen] error reading storage.json: ${e} — assuming not open`);
    return false;
  }
}

function handleUri(uri: vscode.Uri): void {
  log.appendLine(`[handleUri] received: ${uri.toString()}`);

  if (uri.path !== "/open") {
    const msg = `Session Reporter: unknown path "${uri.path}"`;
    log.appendLine(`[handleUri] error: ${msg}`);
    vscode.window.showErrorMessage(msg);
    return;
  }

  const params = new URLSearchParams(uri.query);
  const folder = params.get("folder") ?? undefined;
  const remote = params.get("remote") ?? undefined;

  log.appendLine(`[handleUri] remote=${remote} folder=${folder}`);

  if (!folder && !remote) {
    const msg = "Session Reporter: at least one of 'folder' or 'remote' is required";
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

    // Decide forceNewWindow:
    //   - target window open      → forceNewWindow: false → focuses it
    //   - target not open, only 1 VS Code window exists (dashboard was auto-restored
    //     as a side-effect of launching via URI) → forceNewWindow: false → replaces it
    //   - target not open, multiple windows open → forceNewWindow: true → new window
    const windowIsOpen = isWindowCurrentlyOpen(targetUri);
    const forceNewWindow = !windowIsOpen && countOpenWindows() !== 1;
    log.appendLine(`[handleUri] windowIsOpen=${windowIsOpen} openWindows=${countOpenWindows()} → forceNewWindow=${forceNewWindow}`);
    vscode.commands.executeCommand("vscode.openFolder", targetUri, { forceNewWindow }).then(
      () => log.appendLine("[handleUri] openFolder executed"),
      (err) => {
        log.appendLine(`[handleUri] openFolder error: ${err}`);
        vscode.window.showErrorMessage(`Session Reporter: failed to open folder — ${err}`);
      }
    );
    return;
  } else if (folder) {
    log.appendLine(`[handleUri] opening local folder: ${folder}`);
    targetUri = vscode.Uri.file(folder);
  } else {
    vscode.window.showErrorMessage("session-reporter: missing folder parameter");
    return;
  }

  const windowIsOpen2 = isWindowCurrentlyOpen(targetUri);
  const forceNewWindow = !windowIsOpen2 && countOpenWindows() !== 1;
  log.appendLine(`[handleUri] windowIsOpen=${windowIsOpen2} openWindows=${countOpenWindows()} → forceNewWindow=${forceNewWindow}`);
  vscode.commands.executeCommand("vscode.openFolder", targetUri, { forceNewWindow }).then(
    () => log.appendLine("[handleUri] openFolder command executed"),
    (err) => {
      log.appendLine(`[handleUri] openFolder error: ${err}`);
      vscode.window.showErrorMessage(`Session Reporter: failed to open folder — ${err}`);
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

  const config = vscode.workspace.getConfiguration("sessionReporter");
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
  const config = vscode.workspace.getConfiguration("sessionReporter");

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
    `vscode://remote.session-reporter/open` +
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
