import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { beforeEach } from "node:test";
import { findAppTerminal, findHerdrAppExecutable, focusAppPane, focusNotificationTarget, focusPane,
  herdrAppRequest, herdrRequest } from "../helpers/macos-notify-focus.mjs";

const realExecFile = childProcess.execFile;
const realRun = promisify(realExecFile);
const commands = [];
let commandResult;
const fakeExecFile = () => { throw new Error("Expected promisified execFile"); };
fakeExecFile[promisify.custom] = async (file, args, options) => {
  commands.push({ file, args, options });
  return commandResult(file, args);
};
childProcess.execFile = fakeExecFile;
syncBuiltinESMExports();
let extension;
try {
  extension = await import("../extensions/macos-notify.ts");
} finally {
  childProcess.execFile = realExecFile;
  syncBuiltinESMExports();
}
const { default: register, buildNotifierArguments, buildNotificationArguments } = extension;
beforeEach(() => {
  commands.length = 0;
  commandResult = async file => ({ stdout: file === "git" ? "/tmp/project\n" : "", stderr: "" });
});

function session(t, { mode = "tui", name, env = {}, settings = {} } = {}) {
  const keys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "__CFBundleIdentifier", "PI_SUBAGENT_CHILD",
    "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HERDR_APP_HOME", "PATH"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) if (key !== "PATH") delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  const handlers = new Map();
  const warnings = [];
  register({ on: (event, handler) => handlers.set(event, handler), getSessionName: () => name, getSettings: () => settings });
  const ctx = { mode, cwd: "/tmp/project/subdir", hasUI: true, ui: { notify: text => warnings.push(text) } };
  return { handlers, ctx, warnings, settle: () => handlers.get("agent_settled")({ aborted: false }, ctx) };
}

test("notification summary defaults to gpt-6-luna with minimal reasoning", async t => {
  const dir = await mkdtemp("/tmp/pi-notify-model-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const refs = await extension.loadFastReferences(dir, false, dir);
  assert.deepEqual(refs, [{ provider: "openai-codex", model: "gpt-6-luna", priority: 1 }]);
  const model = { provider: "openai-codex", id: "gpt-6-luna" };
  let called = false;
  const registry = {
    getAvailable: () => [model],
    streamSimple(selected, context, options) {
      called = true;
      assert.equal(selected, model);
      assert.equal(options.reasoning, "minimal");
      return { result: async () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Готово." }] }) };
    },
  };
  assert.equal(await extension.summarizeAnswer("Работа завершена.", registry, refs), "Готово.");
  assert.equal(called, true);
});

const value = (args, flag) => args[args.indexOf(flag) + 1].slice(1);

async function serverFixture(t, reply) {
  const dir = await mkdtemp("/tmp/pi-notify-");
  const path = `${dir}/test.sock`;
  const requests = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]);
      requests.push(request);
      const response = reply(request, socket);
      if (response !== undefined) socket.end(JSON.stringify({ id: request.id, ...response }) + "\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { path, requests };
}

const inheritedEnv = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/not-used.sock", HERDR_PANE_ID: "old:p2" };
for (const [description, mode, child] of [
  ["async child", "tui", "1"],
  ["in-process child", "print", undefined],
  ["nested print child", "print", "1"],
  ["JSON worker", "json", undefined],
  ["RPC host", "rpc", undefined],
]) {
  test(`${description} has no notification or metadata side effects`, async t => {
    const env = { ...inheritedEnv, ...(child ? { PI_SUBAGENT_CHILD: child } : {}) };
    const s = session(t, { mode, env });
    await s.settle();
    assert.deepEqual(commands, []);
    assert.deepEqual(s.warnings, []);
  });
}

test("only the primary settled event notifies, not child completions", async t => {
  const s = session(t, { name: "coordinator" });
  assert.equal(s.handlers.has("agent_end"), false);
  s.ctx.mode = "print";
  await s.settle();
  await s.handlers.get("agent_settled")({ aborted: true }, s.ctx);
  assert.equal(commands.length, 0);
  s.ctx.mode = "tui";
  await s.settle();
  assert.equal(commands.filter(c => c.file === "terminal-notifier").length, 1);
  assert.equal(value(commands.at(-1).args, "-title"), "Pi·project");
  assert.equal(value(commands.at(-1).args, "-message"), "Ready.");
  assert.equal(commands.at(-1).args.includes("-execute"), false);
});

test("independent primary sessions each notify", async t => {
  const first = session(t, { name: "first" });
  const second = session(t, { name: "second" });
  await first.settle();
  await second.settle();
  assert.equal(commands.filter(c => c.file === "terminal-notifier").length, 2);
});

test("shutdown cancels a pending notification and a new runtime sends only once", async t => {
  const old = session(t);
  let finishGit;
  commandResult = () => new Promise(resolve => { finishGit = resolve; });
  const pending = old.settle();
  old.handlers.get("session_shutdown")();
  finishGit({ stdout: "/tmp/project\n" });
  await pending;
  assert.equal(commands.some(c => c.file === "terminal-notifier"), false);
  await old.settle();
  commandResult = async () => ({ stdout: "/tmp/project\n", stderr: "" });
  await session(t).settle();
  assert.equal(commands.filter(c => c.file === "terminal-notifier").length, 1);
});

test("names are normalized and technical routing data stays hidden", async () => {
  const target = { socketPath: "/tmp/private.sock", terminalId: "hidden-terminal", appId: "com.mitchellh.ghostty" };
  const args = buildNotifierArguments("  worker\n\u001b 👩‍💻  ", "[project]", target);
  assert.equal(value(args, "-title"), "Pi·worker 👩‍💻");
  assert.equal(value(args, "-subtitle"), "[project]");
  assert.equal(value(args, "-message"), "Ready. Click to open.");
  assert.equal(args[args.indexOf("-sound") + 1], "Glass");
  const visible = ["-title", "-subtitle", "-message"].map(flag => value(args, flag)).join("\n");
  assert.doesNotMatch(visible, /hidden-terminal|private\.sock|Herdr|w1A:p2/);
  assert.ok(value(buildNotifierArguments("x".repeat(200), "repo"), "-title").length <= 83);
  assert.equal(value(buildNotifierArguments("", "repo"), "-title"), "Pi·repo");
  assert.equal(value(buildNotifierArguments("", ""), "-title"), "Pi");
});

test("the same terminal reuses its replacement group after names or agent sessions change", () => {
  const target = { socketPath: "/tmp/server.sock", terminalId: "stable" };
  const original = buildNotifierArguments("worker", "repo", target);
  const updated = buildNotifierArguments("renamed", "other-repo", {
    ...target, agentSession: { agent: "pi", kind: "id", value: "new-session" },
  });
  assert.notEqual(original.indexOf("-group"), -1, "clickable notifications need a replacement group");
  assert.notEqual(updated.indexOf("-group"), -1);
  const group = original[original.indexOf("-group") + 1];
  assert.ok(group.length > 0);
  assert.equal(updated[updated.indexOf("-group") + 1], group);
  assert.notEqual(value(original, "-execute"), value(updated, "-execute"));
  assert.equal(value(updated, "-message"), "Ready. Click to open.");
});

test("different terminals and servers never share replacement groups", () => {
  const targets = [
    { socketPath: "/tmp/server.sock", terminalId: "first" },
    { socketPath: "/tmp/server.sock", terminalId: "second" },
    { socketPath: "/tmp/other.sock", terminalId: "first" },
    { socketPath: "/tmp/server.sock:first", terminalId: "second" },
    { socketPath: "/tmp/server.sock", terminalId: "first:second" },
  ];
  const groups = targets.map(target => {
    const args = buildNotifierArguments("same-name", "same-repo", target);
    assert.notEqual(args.indexOf("-group"), -1);
    return args[args.indexOf("-group") + 1];
  });
  assert.equal(new Set(groups).size, targets.length);
  assert.equal(buildNotifierArguments("worker", "repo").includes("-group"), false);
});

test("the click command preserves quotes, Unicode and shell metacharacters as data", async () => {
  const target = { socketPath: "/tmp/a'b \"$HOME;`echo nope` 😀.sock", terminalId: "term_quoted" };
  const command = value(buildNotifierArguments("worker", "repo", target), "-execute");
  const { stdout } = await realRun("/bin/sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`]);
  const args = stdout.split("\0").slice(0, -1);
  assert.equal(args[0], process.execPath);
  assert.equal(args[1], fileURLToPath(new URL("../helpers/macos-notify-focus.mjs", import.meta.url)));
  assert.deepEqual(JSON.parse(args[2]), target);
});

test("Herdr metadata uses our tab label, not agent/session titles or the focused tab; no focus occurs on delivery", async t => {
  let tabName = "π";
  const { path, requests } = await serverFixture(t, request => ({ result: request.method === "pane.current"
    ? { pane: { pane_id: "moved:p7", tab_id: "moved:t3", terminal_id: "stable", title: "tdo coordinator", agent: "pi" } }
    : { tabs: [
        { tab_id: "other:t1", label: "focused-tab", focused: true },
        { tab_id: "old:t2", label: "stale-tab" },
        { tab_id: "moved:t3", label: tabName },
      ] } }));
  const s = session(t, { name: "session-name", env: { ...inheritedEnv, HERDR_TAB_ID: "old:t2", HERDR_SOCKET_PATH: path, __CFBundleIdentifier: "com.mitchellh.ghostty" } });
  await s.settle();
  assert.deepEqual(requests.map(({ method, params }) => ({ method, params })).sort((a, b) => a.method.localeCompare(b.method)), [
    { method: "pane.current", params: { caller_pane_id: "old:p2" } },
    { method: "tab.list", params: {} },
  ]);
  const notification = commands.find(c => c.file === "terminal-notifier");
  assert.equal(value(notification.args, "-title"), "Pi·π");
  assert.equal(value(notification.args, "-subtitle"), "project");
  assert.match(value(notification.args, "-execute"), /stable/);
  tabName = "reviewer";
  await s.settle();
  assert.equal(value(commands.at(-1).args, "-title"), "Pi·reviewer");
});

for (const tabs of [undefined, {}, { tabs: [] }, { tabs: [{ tab_id: "other:t1", label: "wrong-tab" }] }]) {
  test(`missing tab metadata falls back to the directory, never the agent or session (${JSON.stringify(tabs)})`, async t => {
    const { path } = await serverFixture(t, request => request.method === "pane.current"
      ? { result: { pane: { tab_id: "own:t1", title: "agent-title", agent: "pi" } } }
      : tabs ? { result: tabs } : { error: { message: "unavailable" } });
    await session(t, { name: "session-name", env: { ...inheritedEnv, HERDR_SOCKET_PATH: path } }).settle();
    assert.equal(value(commands.at(-1).args, "-title"), "Pi·project");
    assert.equal(value(commands.at(-1).args, "-subtitle"), "project");
  });
}

test("tab label is available from inherited tab ID if pane lookup fails", async t => {
  const { path } = await serverFixture(t, request => request.method === "pane.current"
    ? { error: { message: "pane unavailable" } }
    : { result: { tabs: [{ tab_id: "own:t1", label: "π" }] } });
  await session(t, { env: { ...inheritedEnv, HERDR_TAB_ID: "own:t1", HERDR_SOCKET_PATH: path } }).settle();
  assert.equal(value(commands.at(-1).args, "-title"), "Pi·π");
  assert.equal(commands.at(-1).args.includes("-execute"), false);
});

test("failed Git and Herdr lookups still deliver a plain notification", async t => {
  commandResult = async file => {
    if (file === "git") throw new Error("not a repository");
    return { stdout: "", stderr: "" };
  };
  await session(t, { env: inheritedEnv }).settle();
  const args = commands.at(-1).args;
  assert.equal(value(args, "-title"), "Pi·subdir");
  assert.equal(value(args, "-message"), "Ready.");
  assert.equal(args.includes("-execute"), false);
});

test("missing notifier uses non-clickable AppleScript and warns only once", async t => {
  commandResult = async file => {
    if (file === "terminal-notifier") throw Object.assign(new Error("not installed"), { code: "ENOENT" });
    return { stdout: file === "git" ? "/tmp/project\n" : "", stderr: "" };
  };
  const { path } = await serverFixture(t, request => ({ result: request.method === "pane.current"
    ? { pane: { tab_id: "own:t1", title: "agent-title" } }
    : { tabs: [{ tab_id: "own:t1", label: "π" }] } }));
  const s = session(t, { name: "worker", env: { ...inheritedEnv, HERDR_SOCKET_PATH: path } });
  await s.settle();
  await s.settle();
  const fallback = commands.filter(c => c.file === "/usr/bin/osascript");
  assert.equal(fallback.length, 2);
  assert.deepEqual(fallback[0].args, buildNotificationArguments("Ready.", "Pi·π", "Glass", "project"));
  assert.equal(s.warnings.length, 1);
});

test("delivery failures are handled without blindly duplicating notifications", async t => {
  commandResult = async file => {
    if (file === "terminal-notifier") throw Object.assign(new Error("permission denied"), { code: 3 });
    return { stdout: "/tmp/project\n", stderr: "" };
  };
  const s = session(t);
  await s.settle();
  assert.equal(s.warnings.length, 1);
  assert.equal(commands.some(c => c.file === "/usr/bin/osascript"), false);
});

test("click resolves a moved terminal to its current pane ID", async t => {
  const { path, requests } = await serverFixture(t, request => ({ result: request.method === "pane.list"
    ? { panes: [{ terminal_id: "other", pane_id: "old:p1" }, { terminal_id: "stable", pane_id: "new:p9" }] }
    : { type: "ok" } }));
  const pane = await focusPane({ socketPath: path, terminalId: "stable" });
  assert.equal(pane.pane_id, "new:p9");
  assert.equal(requests[1].method, "pane.focus");
  assert.deepEqual(requests[1].params, { pane_id: "new:p9" });
});

for (const [description, panes, extra, message] of [
  ["closed", [{ terminal_id: "other", pane_id: "new:p9", title: "same name" }], {}, /closed or ambiguous/],
  ["ambiguous", [{ terminal_id: "stable" }, { terminal_id: "stable" }], {}, /closed or ambiguous/],
  ["replaced agent", [{ terminal_id: "stable", pane_id: "new:p9", agent_session: { agent: "pi", kind: "id", value: "new" } }],
    { agentSession: { agent: "pi", kind: "id", value: "original" } }, /no longer/],
]) {
  test(`click does not focus a ${description} target`, async t => {
    const { path, requests } = await serverFixture(t, () => ({ result: { panes } }));
    await assert.rejects(focusPane({ socketPath: path, terminalId: "stable", ...extra }), message);
    assert.equal(requests.length, 1);
  });
}

test("socket API errors, malformed JSON and unexpected IDs are rejected", async t => {
  for (const response of ["{bad\n", JSON.stringify({ id: "wrong", result: {} }) + "\n", JSON.stringify({ id: "macos-notify", error: { message: "test failure" } }) + "\n"]) {
    const { path } = await serverFixture(t, (_request, socket) => { socket.end(response); });
    await assert.rejects(herdrRequest(path, "pane.list", {}));
  }
});

test("unresponsive sockets have a bounded deadline", async t => {
  const { path } = await serverFixture(t, () => undefined);
  await assert.rejects(herdrRequest(path, "pane.list", {}), /timed out/);
});

test("matching agent identities allow focus", async t => {
  const identity = { agent: "pi", kind: "id", value: "original" };
  const { path, requests } = await serverFixture(t, request => ({ result: request.method === "pane.list"
    ? { panes: [{ terminal_id: "stable", pane_id: "new:p9", agent_session: identity }] }
    : { type: "ok" } }));
  await focusPane({ socketPath: path, terminalId: "stable", agentSession: identity });
  assert.equal(requests[1].method, "pane.focus");
});

test("fragmented UTF-8 responses preserve names and early EOF is rejected", async t => {
  const { path } = await serverFixture(t, (request, socket) => {
    const response = Buffer.from(JSON.stringify({ id: request.id, result: { title: "😀 worker" } }) + "\n");
    const split = response.indexOf(Buffer.from("😀")) + 1;
    socket.write(response.subarray(0, split));
    setImmediate(() => socket.end(response.subarray(split)));
  });
  assert.equal((await herdrRequest(path, "pane.current", {})).title, "😀 worker");
  const closed = await serverFixture(t, (_request, socket) => { socket.end(); });
  await assert.rejects(herdrRequest(closed.path, "pane.current", {}), /without a response/);
});

const appSettings = { macosNotify: { navigationTarget: "app" } };
const appState = () => ({ spaces: [
  { id: "sp-other", active: true, tabs: [{ id: "tb-other", name: "focused-tab", terminals: [{ terminal: "t1", pane: "p-other" }] }] },
  { id: "sp-own", active: false, tabs: [{ id: "tb-own", name: "π", terminals: [{ terminal: "t7", pane: "p-own", sub_agents: [{ terminal: "t8" }] }] }] },
] });

async function appFixture(t) {
  const directory = await mkdtemp("/tmp/pi-app-notify-");
  await writeFile(`${directory}/herdr-app`, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executablePath = await realpath(`${directory}/herdr-app`);
  const appHome = `${directory}/custom home 😀`;
  return {
    executablePath, appHome,
    env: { HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/tmp/core.sock", HERDR_APP_HOME: appHome, PATH: directory },
    target: { backend: "app", executablePath, appHome, terminalId: "t7", paneId: "p-own" },
  };
}

function appRunner(state, result = {}) {
  const calls = [];
  return {
    calls,
    execute: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: JSON.stringify(args[0] === "ls" ? state : result), stderr: "" };
    },
  };
}

test("App resolves our HC terminal and fresh tab name without navigating on delivery", async t => {
  const app = await appFixture(t);
  const state = appState();
  commandResult = async file => ({ stdout: file === app.executablePath ? JSON.stringify(state) : "/tmp/project\n", stderr: "" });
  const s = session(t, { settings: appSettings, env: { ...inheritedEnv, ...app.env, __CFBundleIdentifier: "com.mitchellh.ghostty" } });
  await s.settle();
  const notification = commands.find(c => c.file === "terminal-notifier");
  assert.equal(value(notification.args, "-title"), "Pi·π");
  assert.equal(value(notification.args, "-subtitle"), "project");
  assert.equal(value(notification.args, "-message"), "Ready. Click to open.");
  const command = value(notification.args, "-execute");
  const { stdout } = await realRun("/bin/sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`]);
  assert.deepEqual(JSON.parse(stdout.split("\0")[2]), app.target);
  const appCalls = commands.filter(c => c.file === app.executablePath);
  assert.deepEqual(appCalls.map(c => c.args), [["ls"]]);
  assert.equal(appCalls[0].options.env.HERDR_APP_HOME, app.appHome);
  assert.equal(commands.some(c => c.file === "/usr/bin/open"), false);
  state.spaces[1].tabs[0].name = "renamed";
  await s.settle();
  assert.equal(value(commands.at(-1).args, "-title"), "Pi·renamed");
});

for (const [description, state] of [
  ["missing terminal", { spaces: [] }],
  ["ambiguous terminal", { spaces: [{ id: "s", tabs: [{ id: "t", terminals: [{ terminal: "t7", pane: "p" }, { terminal: "t7", pane: "q" }] }] }] }],
  ["malformed metadata", {}],
]) {
  test(`App ${description} still sends a plain alert`, async t => {
    const app = await appFixture(t);
    commandResult = async file => ({ stdout: file === app.executablePath ? JSON.stringify(state) : "/tmp/project\n" });
    await session(t, { settings: appSettings, env: app.env }).settle();
    const args = commands.at(-1).args;
    assert.equal(value(args, "-title"), "Pi·project");
    assert.equal(value(args, "-message"), "Ready.");
    assert.equal(args.includes("-execute"), false);
  });
}

for (const response of ["{bad", '{"error":"window closed"}']) {
  test(`App CLI failure does not suppress the notification (${response})`, async t => {
    const app = await appFixture(t);
    commandResult = async file => ({ stdout: file === app.executablePath ? response : "/tmp/project\n" });
    await session(t, { settings: appSettings, env: app.env }).settle();
    assert.equal(value(commands.at(-1).args, "-message"), "Ready.");
  });
}

test("App selection without HC context never falls back to TUI or the focused App terminal", async t => {
  await session(t, { settings: appSettings, env: inheritedEnv }).settle();
  assert.deepEqual(commands.map(c => c.file), ["git", "terminal-notifier"]);
  assert.equal(value(commands.at(-1).args, "-message"), "Ready.");
});

for (const [mode, child] of [["tui", "1"], ["print"], ["json"], ["rpc"]]) {
  test(`App metadata and alerts are also skipped for ${mode} child=${child}`, async t => {
    const app = await appFixture(t);
    await session(t, { settings: appSettings, mode, env: { ...app.env, ...(child ? { PI_SUBAGENT_CHILD: child } : {}) } }).settle();
    assert.deepEqual(commands, []);
  });
}

test("explicit TUI selection ignores App context and keeps the legacy callback", async t => {
  const app = await appFixture(t);
  const { path } = await serverFixture(t, request => ({ result: request.method === "pane.current"
    ? { pane: { tab_id: "own:t1", terminal_id: "stable" } }
    : { tabs: [{ tab_id: "own:t1", label: "TUI tab" }] } }));
  await session(t, { settings: { macosNotify: { navigationTarget: "tui" } },
    env: { ...app.env, ...inheritedEnv, HERDR_SOCKET_PATH: path } }).settle();
  assert.equal(value(commands.at(-1).args, "-title"), "Pi·TUI tab");
  assert.match(value(commands.at(-1).args, "-execute"), /stable/);
  assert.equal(commands.some(c => c.file === app.executablePath), false);
});

test("invalid navigation setting disables only navigation and warns once", async t => {
  const s = session(t, { settings: { macosNotify: { navigationTarget: "typo" } } });
  await s.settle();
  await s.settle();
  assert.equal(s.warnings.length, 1);
  assert.equal(commands.filter(c => c.file === "terminal-notifier").length, 2);
  assert.equal(value(commands.at(-1).args, "-message"), "Ready.");
});

test("App grouping is stable across renames and moves, isolated from TUI and other App homes", async t => {
  const { target } = await appFixture(t);
  const group = target => {
    const args = buildNotifierArguments("tab", "repo", target);
    return args[args.indexOf("-group") + 1];
  };
  assert.equal(group(target), group({ ...target, paneId: "moved-pane" }));
  const groups = [target, { ...target, appHome: "/tmp/other-home" }, { ...target, terminalId: "t8" },
    { socketPath: target.appHome, terminalId: target.terminalId }].map(group);
  assert.equal(new Set(groups).size, 4);
});

test("App click finds its pane in the current space/tab and activates only Herdr App", async t => {
  const { target } = await appFixture(t);
  const state = appState();
  state.spaces[1].id = "moved-space";
  state.spaces[1].tabs[0].id = "moved-tab";
  const { execute, calls } = appRunner(state);
  const pane = await focusNotificationTarget({ ...target, appId: "com.mitchellh.ghostty" }, execute);
  assert.equal(pane.pane, "p-own");
  assert.deepEqual(calls.map(c => [c.file, c.args]), [
    [target.executablePath, ["ls"]],
    [target.executablePath, ["do", "pane.focus", '{"pane":"p-own"}']],
    ["/usr/bin/open", ["-b", "dev.herdr.app"]],
  ]);
  assert.equal(calls[0].options.env.HERDR_APP_HOME, target.appHome);
  assert.equal(calls[1].options.env.HERDR_APP_HOME, target.appHome);
  assert.equal(calls[0].options.timeout, 3000);
});

for (const [description, change] of [
  ["closed terminal", state => { state.spaces.pop(); }],
  ["reused terminal address", state => { state.spaces[1].tabs[0].terminals[0].pane = "new-pane-uuid"; }],
  ["ambiguous terminal", state => { state.spaces[1].tabs[0].terminals.push({ terminal: "t7", pane: "duplicate" }); }],
]) {
  test(`App click rejects a ${description} without changing focus or activating an app`, async t => {
    const { target } = await appFixture(t);
    const state = appState();
    change(state);
    const { execute, calls } = appRunner(state);
    await assert.rejects(focusNotificationTarget(target, execute), /closed or ambiguous/);
    assert.deepEqual(calls.map(c => c.args), [["ls"]]);
  });
}

test("App lookup never promotes a sub-agent to a primary pane", () => {
  assert.equal(findAppTerminal(appState(), "t8"), undefined);
});

test("App CLI errors and invalid callback paths fail closed", async t => {
  const { target } = await appFixture(t);
  await assert.rejects(focusAppPane({ ...target, executablePath: "relative" }), /Invalid Herdr App path/);
  await assert.rejects(focusAppPane({ ...target, appHome: "relative" }), /Invalid Herdr App path/);
  await assert.rejects(focusAppPane({ ...target, paneId: "" }), /Missing Herdr App target/);
  await assert.rejects(focusNotificationTarget({ ...target, backend: "unknown" }), /Invalid navigation backend/);
  for (const stdout of ["{bad", "null", '{"error":"app is closed"}']) {
    await assert.rejects(herdrAppRequest(target.executablePath, target.appHome, ["ls"], async () => ({ stdout })));
  }
  const { calls, execute } = appRunner(appState(), { error: "focus failed" });
  await assert.rejects(focusNotificationTarget(target, execute), /focus failed/);
  assert.equal(calls.some(c => c.file === "/usr/bin/open"), false);
});

test("App executable is resolved to an absolute path at delivery time", async t => {
  const app = await appFixture(t);
  assert.equal(findHerdrAppExecutable({ PATH: `/does-not-exist:${app.env.PATH}` }), app.executablePath);
});

test("invalid callback data and CLI input fail without focusing anything", async () => {
  await assert.rejects(focusPane(null), /Missing target/);
  await assert.rejects(focusPane({ terminalId: "stable", socketPath: "relative.sock" }), /Invalid Herdr socket/);
  await assert.rejects(focusPane({ terminalId: "stable", appId: "bad;command" }), /Invalid terminal application/);
  const helper = fileURLToPath(new URL("../helpers/macos-notify-focus.mjs", import.meta.url));
  await assert.rejects(realRun(process.execPath, [helper, "{bad"]), error => {
    assert.match(error.stderr, /macos-notify:/);
    return true;
  });
});
