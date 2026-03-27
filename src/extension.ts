/**
 * Session Reporter — VS Code Extension
 *
 * URI Handler  [extensionKind = UI]  — runs on the LOCAL client (Windows)
 * Handles  vscode://remote.session-reporter/open?remote=ALIAS&folder=/path
 * and opens the workspace in a NEW window (forceNewWindow: true).
 *
 * Sessions are managed manually in the dashboard — this extension does NOT
 * report workspaces to the backend.
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

  // ── URI handler ────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri })
  );
  log.appendLine("[activate] URI handler registered → vscode://remote.session-reporter/open");

  // ── Auto-updater (UI only) ─────────────────────────────────────────────────
  if (kind === vscode.ExtensionKind.UI) {
    checkForUpdates(context);
    context.subscriptions.push(
      vscode.commands.registerCommand("sessionReporter.checkForUpdates", () => {
        _checkForUpdates(context);
      })
    );
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
// Auto-updater — UI side only
// ---------------------------------------------------------------------------

const GITHUB_REPO = "bensouille/session-reporter-vscode";

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

  const options: https.RequestOptions = {
    hostname: "api.github.com",
    path: `/repos/${GITHUB_REPO}/releases/latest`,
    method: "GET",
    headers: {
      "User-Agent": "session-reporter-vscode",
      "Accept": "application/vnd.github+json",
    },
  };

  const req = https.get(options, (res) => {
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


