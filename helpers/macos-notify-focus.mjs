import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** One newline-delimited request, with a total deadline rather than an idle timeout. */
export async function herdrRequest(socketPath, method, params) {
  if (typeof socketPath !== "string" || !isAbsolute(socketPath)) {
    throw new Error("Invalid Herdr socket path");
  }
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    const finish = (error, result) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Herdr API timed out")), 2000);
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(new Error("Herdr closed without a response")));
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id: "macos-notify", method, params }) + "\n");
    });
    socket.on("data", chunk => {
      buffer += chunk;
      try {
        if (buffer.length > 4 * 1024 * 1024) throw new Error("Herdr response is too large");
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const response = JSON.parse(buffer.slice(0, newline));
        if (response?.id !== "macos-notify") throw new Error("Unexpected Herdr response ID");
        if (response.error) throw new Error(JSON.stringify(response.error));
        if (!response.result || typeof response.result !== "object") throw new Error("Missing Herdr result");
        finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}

/** Capture an absolute executable: notification callbacks do not inherit the shell's PATH. */
export function findHerdrAppExecutable(env = process.env) {
  const candidates = (env.PATH ?? "").split(delimiter).filter(isAbsolute)
    .map(directory => join(directory, "herdr-app"));
  candidates.push(join(homedir(), ".local/bin/herdr-app"),
    join(homedir(), "Applications/Herdr.app/Contents/MacOS/Herdr"),
    "/Applications/Herdr.app/Contents/MacOS/Herdr");
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch { /* Try the next installed location. */ }
  }
}

/** Use the supported App CLI, not the incompatible TUI socket protocol. Never launch a window. */
export async function herdrAppRequest(executablePath, appHome, args, execute = run) {
  if (typeof executablePath !== "string" || !isAbsolute(executablePath) ||
      typeof appHome !== "string" || !isAbsolute(appHome)) {
    throw new Error("Invalid Herdr App path");
  }
  const { stdout } = await execute(executablePath, args, {
    env: { ...process.env, HERDR_APP_HOME: appHome }, timeout: 3000, maxBuffer: 4 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  if (!result || typeof result !== "object" || result.error) {
    throw new Error(result?.error || "Missing Herdr App result");
  }
  return result;
}

/** Ignore sub-agents and never identify a terminal by its label, folder or current focus. */
export function findAppTerminal(result, terminalId) {
  if (!Array.isArray(result?.spaces)) throw new Error("Missing Herdr App space list");
  const matches = [];
  for (const space of result.spaces) {
    for (const tab of space.tabs ?? []) {
      for (const pane of tab.terminals ?? []) {
        if (pane.terminal === terminalId) matches.push({ space, tab, pane });
      }
    }
  }
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (![match.space.id, match.tab.id, match.pane.pane].every(id => typeof id === "string" && id.length > 0)) {
    return undefined;
  }
  return match;
}

/** Unknown focus state must never hide a readiness notification. */
export async function isNotificationTargetVisible(target, execute = run) {
  if (target?.backend !== "app" || !target.paneId || !target.terminalId) return false;
  try {
    const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e",
      'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js'],
      { timeout: 2000, maxBuffer: 65536 });
    if (stdout.trim() !== "dev.herdr.app") return false;
    const status = await herdrAppRequest(target.executablePath, target.appHome, ["status"], execute);
    return status.focused_pane === target.paneId && status.agent === target.terminalId &&
      Array.isArray(status.overlays) && status.overlays.length === 0;
  } catch {
    return false;
  }
}

export async function focusAppPane(target, execute = run) {
  if (!target || typeof target.terminalId !== "string" || !target.terminalId.trim() ||
      typeof target.paneId !== "string" || !target.paneId.trim()) {
    throw new Error("Missing Herdr App target");
  }
  const result = await herdrAppRequest(target.executablePath, target.appHome, ["ls"], execute);
  const match = findAppTerminal(result, target.terminalId);
  // Reject a recycled terminal address (t1, t2, ...) now attached to a different pane UUID.
  if (!match || match.pane.pane !== target.paneId) throw new Error("Target pane is closed or ambiguous");
  // An explicit model pane selects its owning space/tab, rather than an unrelated layout terminal block.
  await herdrAppRequest(target.executablePath, target.appHome,
    ["do", "pane.focus", JSON.stringify({ pane: match.pane.pane })], execute);
  return match.pane;
}

export async function focusPane(target) {
  if (!target || typeof target.terminalId !== "string" || !target.terminalId.trim()) {
    throw new Error("Missing target terminal");
  }
  if (target.appId !== undefined && (typeof target.appId !== "string" || !/^[\w.-]+$/.test(target.appId))) {
    throw new Error("Invalid terminal application ID");
  }
  if (target.agentSession !== undefined && !["agent", "kind", "value"].every(
    key => typeof target.agentSession?.[key] === "string" && target.agentSession[key].length > 0,
  )) throw new Error("Invalid agent session identity");

  const result = await herdrRequest(target.socketPath, "pane.list", {});
  if (!Array.isArray(result.panes)) throw new Error("Missing Herdr pane list");
  const matches = result.panes.filter(pane => pane?.terminal_id === target.terminalId);
  if (matches.length !== 1) throw new Error("Target pane is closed or ambiguous");
  const pane = matches[0];
  if (typeof pane.pane_id !== "string" || !pane.pane_id) throw new Error("Missing current pane ID");
  if (target.agentSession && !["agent", "kind", "value"].every(
    key => pane.agent_session?.[key] === target.agentSession[key],
  )) throw new Error("The original agent session is no longer in this pane");
  // shortcut: without agent_session Herdr identifies the terminal only; add an occupant identity when its API exposes one.
  await herdrRequest(target.socketPath, "pane.focus", { pane_id: pane.pane_id });
  return pane;
}

export async function focusNotificationTarget(target, execute = run) {
  if (target?.backend !== undefined && target.backend !== "tui" && target.backend !== "app") {
    throw new Error("Invalid navigation backend");
  }
  const pane = target?.backend === "app" ? await focusAppPane(target, execute) : await focusPane(target);
  const appId = target.backend === "app" ? "dev.herdr.app" : target.appId;
  if (appId) {
    // TUI activation still cannot select a particular host window when several clients are open.
    await execute("/usr/bin/open", ["-b", appId], { timeout: 3000 });
  }
  return pane;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    const pane = await focusNotificationTarget(JSON.parse(process.argv[2] ?? "null"));
    console.log("macos-notify: focused", pane.pane_id ?? pane.pane);
  }).catch(error => {
    console.error("macos-notify:", error.message);
    process.exitCode = 1;
  });
}
