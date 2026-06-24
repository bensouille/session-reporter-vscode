/**
 * Session Reporter — VS Code Extension
 *
 * URI Handler  [extensionKind = UI]  — runs on the LOCAL client (Windows)
 * Handles  vscode://remote.session-reporter/open?remote=ALIAS&folder=/path
 * and opens the workspace in a NEW window (forceNewWindow: true).
 *
 * Workspace reporter  [extensionKind = Workspace]  — runs on remote hosts
 * Reports active VS Code workspaces to the dashboard backend.
 */

import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as cp from "child_process";

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

  // ── URI handler ────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri })
  );
  log.appendLine("[activate] URI handler registered → vscode://remote.session-reporter/open");

  // ── Auto-updater (UI only, opt-in) ─────────────────────────────────────────
  if (kind === vscode.ExtensionKind.UI) {
    const cfg = vscode.workspace.getConfiguration("sessionReporter");
    if (cfg.get<boolean>("autoUpdate", false)) {
      checkForUpdates(context);
    }
    context.subscriptions.push(
      vscode.commands.registerCommand("sessionReporter.checkForUpdates", () => {
        _checkForUpdates(context);
      })
    );
  }

  // ── Workspace scanner (reports known workspaces to the dashboard) ──────────
  const onWorkspace = kind === vscode.ExtensionKind.Workspace;
  if (onWorkspace) {
    // Report workspaces after a short delay (let VS Code finish loading)
    setTimeout(() => {
      reportWorkspaces();
      // Also report the currently open workspace as active
      reportActiveWorkspace();
    }, 5000);

    // Listen for workspace folder changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const folder of e.added) {
          sendSession(folder.uri.fsPath, true);
        }
        for (const folder of e.removed) {
          sendSession(folder.uri.fsPath, false);
        }
      })
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("sessionReporter.reportWorkspaces", () => {
      reportWorkspaces();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("sessionReporter.configure", () => {
      configure(context);
    })
  );
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

    // Always open in a new window — forceNewWindow:false relies on isWindowCurrentlyOpen
    // reading storage.json which contains stale entries from previous sessions, causing
    // false positives that make VS Code try to focus a non-existent window and block.
    log.appendLine(`[handleUri] opening target in new window`);
    vscode.commands.executeCommand("vscode.openFolder", targetUri, { forceNewWindow: true }).then(
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

  log.appendLine(`[handleUri] opening target in new window`);
  vscode.commands.executeCommand("vscode.openFolder", targetUri, { forceNewWindow: true }).then(
    () => log.appendLine("[handleUri] openFolder command executed"),
    (err) => {
      log.appendLine(`[handleUri] openFolder error: ${err}`);
      vscode.window.showErrorMessage(`Session Reporter: failed to open folder — ${err}`);
    }
  );
}

// ---------------------------------------------------------------------------
// Workspace scanner — report known remote workspaces to the dashboard
// ---------------------------------------------------------------------------

interface WorkspaceEntry {
  path: string;
  hostname: string;
}

function scanWorkspaceStorage(): WorkspaceEntry[] {
  const results: WorkspaceEntry[] = [];
  const seen = new Set<string>();

  // On VS Code Remote SSH, workspace.json is NOT stored on the server side.
  // Instead, we scan common directories for .git repos (project folders).
  const home = os.homedir();
  const searchDirs: string[] = [];

  // Common project locations — inclut les chemins typiques des serveurs
  const scanPaths = [
    home,
    path.join(home, "projects"),
    path.join(home, "code"),
    path.join(home, "dev"),
    path.join(home, "workspace"),
    path.join(home, "src"),
    path.join(home, "www"),
    "/home",
    "/srv",
    "/srv/www",
    "/var/www",
    "/var/www/html",
    "/opt",
    "/root",
  ];
  for (const dir of scanPaths) {
    if (fs.existsSync(dir)) { searchDirs.push(dir); }
  }

  log.appendLine(`[workspaceScan] scanning ${searchDirs.length} directories for .git repos...`);

  for (const base of searchDirs) {
    log.appendLine(`[workspaceScan] scanning ${base}...`);
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        if (entry.name.startsWith(".")) { continue; }  // skip dot-dirs
        const gitDir = path.join(base, entry.name, ".git");
        if (!fs.existsSync(gitDir)) { continue; }
        const fullPath = path.join(base, entry.name);
        if (!seen.has(fullPath)) {
          seen.add(fullPath);
          results.push({ path: fullPath, hostname: os.hostname() });
          log.appendLine(`[workspaceScan]   found: ${fullPath}`);
        }
      }
    } catch {
      // permission denied — skip
    }
  }

  log.appendLine(`[workspaceScan] found ${results.length} git repos`);
  return results;
}

// ---------------------------------------------------------------------------
// Configuration wizard
// ---------------------------------------------------------------------------

async function configure(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("sessionReporter");

  const backendUrl = await vscode.window.showInputBox({
    title: "Session Reporter (1/2) — Backend URL",
    prompt: "URL du dashboard backend",
    placeHolder: "https://dashboard.example.com",
    value: cfg.get<string>("backendUrl") ?? "",
    validateInput: (v) => {
      if (!v) { return null; }
      try { new URL(v); return null; } catch { return "URL invalide"; }
    },
  });
  if (backendUrl === undefined) { return; }

  const agentToken = await vscode.window.showInputBox({
    title: "Session Reporter (2/2) — Agent Token",
    prompt: "Secret token (AGENT_TOKEN du backend)",
    placeHolder: "874558ee8c5b...",
    password: true,
    value: cfg.get<string>("agentToken") ?? "",
  });
  if (agentToken === undefined) { return; }

  await cfg.update("backendUrl", backendUrl, vscode.ConfigurationTarget.Global);
  await cfg.update("agentToken", agentToken, vscode.ConfigurationTarget.Global);

  if (backendUrl && agentToken) {
    vscode.window.showInformationMessage(
      "Session Reporter: configuration sauvegardée. Lancez 'Signaler les workspaces au dashboard' pour envoyer les workspaces."
    );
  }
}

// ---------------------------------------------------------------------------
// Workspace scanner — report known remote workspaces to the dashboard
// ---------------------------------------------------------------------------

function reportWorkspaces(): void {
  const cfg = vscode.workspace.getConfiguration("sessionReporter");
  const backendUrl = cfg.get<string>("backendUrl", "").replace(/\/+$/, "");
  const agentToken = cfg.get<string>("agentToken", "");

  if (!backendUrl || !agentToken) {
    log.appendLine("[workspaceScan] backendUrl or agentToken not configured — skipping");
    return;
  }

  const workspaces = scanWorkspaceStorage();
  if (workspaces.length === 0) {
    log.appendLine("[workspaceScan] no workspaces to report");
    return;
  }

  log.appendLine(`[workspaceScan] reporting ${workspaces.length} workspaces to ${backendUrl}`);

  let completed = 0;
  let failed = 0;

  for (const ws of workspaces) {
    sendSession(ws.path, true, backendUrl, agentToken, ws.hostname, (ok) => {
      if (ok) completed++; else failed++;
      if (completed + failed === workspaces.length) {
        log.appendLine(`[workspaceScan] done: ${completed} ok, ${failed} failed`);
      }
    });
  }
}

/** Report the currently opened workspace (if any) as active. */
function reportActiveWorkspace(): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    log.appendLine(`[activeWorkspace] reporting current workspace: ${folder.uri.fsPath}`);
    sendSession(folder.uri.fsPath, true);
  }
}

/** Send a single session to the backend. */
function sendSession(
  repoPath: string,
  isActive: boolean,
  backendUrl?: string,
  agentToken?: string,
  hostname?: string,
  callback?: (ok: boolean) => void
): void {
  const cfg = vscode.workspace.getConfiguration("sessionReporter");
  const url = backendUrl || cfg.get<string>("backendUrl", "").replace(/\/+$/, "");
  const token = agentToken || cfg.get<string>("agentToken", "");

  if (!url || !token) {
    log.appendLine("[sendSession] backendUrl or agentToken not configured — skipping");
    callback?.(false);
    return;
  }

  const host = hostname || os.hostname();
  const body = JSON.stringify({
    hostname: host,
    repo: repoPath,
    vscode_url: `vscode://remote.session-reporter/open?remote=${encodeURIComponent(host)}&folder=${encodeURIComponent(repoPath)}`,
    is_active: isActive,
  });

  const apiUrl = new URL(url + "/api/v1/hosts/session-sync");
  const options: https.RequestOptions = {
    hostname: apiUrl.hostname,
    port: apiUrl.port || (apiUrl.protocol === "https:" ? 443 : 80),
    path: apiUrl.pathname + apiUrl.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "X-Agent-Token": token,
      "User-Agent": "session-reporter-vscode",
    },
  };

  const transport = apiUrl.protocol === "https:" ? https : http;
  const req = transport.request(options, (res) => {
    let data = "";
    res.on("data", (chunk: string) => { data += chunk; });
    res.on("end", () => {
      const ok = res.statusCode === 200 || res.statusCode === 201;
      if (!ok) {
        log.appendLine(`[sendSession] ${host}:${repoPath} → ${res.statusCode}`);
      }
      callback?.(ok);
    });
  });
  req.on("error", (e: Error) => {
    log.appendLine(`[sendSession] ${host}:${repoPath} error: ${e.message}`);
    callback?.(false);
  });
  req.write(body);
  req.end();
}

// ---------------------------------------------------------------------------
// Auto-updater — UI side only
// ---------------------------------------------------------------------------

function getGithubRepo(): string {
  const cfg = vscode.workspace.getConfiguration("sessionReporter");
  return cfg.get<string>("githubRepo") || "bensouille/session-reporter-vscode";
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) { return aMaj - bMaj; }
  if (aMin !== bMin) { return aMin - bMin; }
  return aPat - bPat;
}

function checkForUpdates(context: vscode.ExtensionContext): void {
  // Delay 8 s to avoid blocking activation
  setTimeout(() => _checkForUpdates(context), 8000);
}

function _checkForUpdates(context: vscode.ExtensionContext): void {
  log.appendLine("[updater] checking for updates…");

  const repo = getGithubRepo();

  const options: https.RequestOptions = {
    hostname: "api.github.com",
    path: `/repos/${repo}/releases/latest`,
    method: "GET",
    headers: {
      "User-Agent": "session-reporter-vscode",
      "Accept": "application/vnd.github+json",
    },
  };

  const req = https.get(options, (res) => {
    // GitHub API rate limit handling
    if (res.statusCode === 403 && res.headers["x-ratelimit-remaining"] === "0") {
      const resetTime = res.headers["x-ratelimit-reset"];
      const resetDate = resetTime ? new Date(Number(resetTime) * 1000).toLocaleTimeString() : "inconnue";
      log.appendLine(`[updater] GitHub API rate limit exceeded — retry after ${resetDate}`);
      return;
    }

    let body = "";
    res.on("data", (chunk: string) => { body += chunk; });
    res.on("end", () => {
      try {
        const release = JSON.parse(body);
        const latestTag: string = release.tag_name ?? "";
        const currentVersion: string = context.extension.packageJSON.version;

        log.appendLine(`[updater] current=${currentVersion} latest=${latestTag}`);

        if (!latestTag || compareSemver(latestTag, currentVersion) <= 0) {
          log.appendLine("[updater] already up to date");
          return;
        }

        const assets: Array<{ name: string; browser_download_url: string }> = release.assets ?? [];
        const vsixAsset = assets.find(a => a.name.endsWith(".vsix"));
        if (!vsixAsset) {
          log.appendLine("[updater] no .vsix asset found in release");
          return;
        }

        log.appendLine(`[updater] update available: ${latestTag}`);
        vscode.window.showInformationMessage(
          `Session Reporter ${latestTag} est disponible (actuel : ${currentVersion})`,
          "Mettre à jour",
          "Notes de version"
        ).then(choice => {
          if (choice === "Mettre à jour") {
            downloadAndInstall(vsixAsset.browser_download_url, vsixAsset.name, latestTag);
          } else if (choice === "Notes de version") {
            vscode.env.openExternal(vscode.Uri.parse(release.html_url as string));
          }
        });
      } catch (e) {
        log.appendLine(`[updater] failed to parse release response: ${e}`);
      }
    });
  });

  req.on("error", (e: Error) => log.appendLine(`[updater] request error: ${e.message}`));
}

function downloadAndInstall(downloadUrl: string, assetName: string, version: string): void {
  const tmpPath = path.join(os.tmpdir(), assetName);
  log.appendLine(`[updater] downloading → ${tmpPath}`);

  const file = fs.createWriteStream(tmpPath);

  const doRequest = (url: string): void => {
    const transport = url.startsWith("https") ? https : http;
    transport.get(url, { headers: { "User-Agent": "session-reporter-vscode" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        doRequest(res.headers.location);
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        log.appendLine("[updater] download complete — installing…");
        vscode.commands.executeCommand(
          "workbench.extensions.installExtension",
          vscode.Uri.file(tmpPath)
        ).then(
          () => {
            log.appendLine(`[updater] installed ${version}`);
            vscode.window.showInformationMessage(
              `Session Reporter ${version} installé. Rechargez VSCode pour l'activer.`,
              "Recharger"
            ).then(choice => {
              if (choice === "Recharger") {
                vscode.commands.executeCommand("workbench.action.reloadWindow");
              }
            });
          },
          (err: unknown) => {
            log.appendLine(`[updater] install failed: ${err}`);
            vscode.window.showErrorMessage(`Session Reporter: échec de la mise à jour — ${err}`);
          }
        );
      });
    }).on("error", (e: Error) => {
      log.appendLine(`[updater] download error: ${e.message}`);
      vscode.window.showErrorMessage(`Session Reporter: échec du téléchargement — ${e.message}`);
    });
  };

  doRequest(downloadUrl);
}


