const ADDRESS = /^(?:[a-z0-9][a-z0-9_.-]{0,31}\/)?t[a-z0-9]+$/;
const MACHINE_LOGIN = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/;
const RECORD_ID = "pi-notify-summary";
const quote = (arg) => "'" + arg.replace(/'/g, "'\\''") + "'";
const value = (text) => "\\" + text;
const clean = (text, limit) => typeof text === "string"
  ? [...text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim()].slice(0, limit).join("")
  : "";

export function agentAddress(p) {
  const terminal = p.action?.args?.terminal;
  return p.action?.name === "agent.focus" && typeof terminal === "string" && ADDRESS.test(terminal) ? terminal : null;
}

export function planToast(p, info, paths, seen) {
  const terminal = agentAddress(p);
  const title = clean(p.title, 200);
  const body = clean(p.body, 1000);
  // Leave service toasts with buttons or unsupported actions inside Herdr.
  if (!(title || body) || (p.action && !terminal) || MACHINE_LOGIN.test(body)) return null;
  const record = terminal && info?.address === terminal ? info : null;
  const app = record?.report?.app;
  const key = record?.program?.key;
  const sender = app === "pi" || (!app && key === "pi") ? "pi"
    : app === "codex" || app === "codex-cli" || (!app && key === "codex") ? "codex" : "default";
  const args = ["-title", value(body ? title || "Herdr" : "Herdr"), "-message", value(body || title)];
  let summaryKey;
  if (sender === "pi" && record.status === "done" && p.level === "info") {
    const summary = record.records?.[RECORD_ID];
    if (summary?.app === "pi" && summary.state === "done" && typeof summary.msg === "string") {
      try {
        const { id, text } = JSON.parse(summary.msg);
        const message = clean(text, 250);
        if (/^[a-f0-9-]{36}$/.test(id) && message && !seen.has(`${terminal}/${id}`)) {
          summaryKey = `${terminal}/${id}`;
          args[3] = value(message);
          if (body) args.push("-subtitle", value(body));
        }
      } catch { /* Invalid summary: keep the original toast text. */ }
    }
  }
  if (terminal) {
    const command = ["/usr/bin/env", `HERDR_APP_HOME=${paths.appHome}`, `${paths.home}/.local/bin/herdr-app`,
      "do", "agent.focus", JSON.stringify({ terminal })].map(quote).join(" ");
    args.push("-group", `herdr-agent-${terminal}`, "-execute", value(`${command}; /usr/bin/open -b dev.herdr.app`));
  } else {
    args.push("-activate", "dev.herdr.app");
  }
  const executable = sender === "default" ? "/opt/homebrew/bin/terminal-notifier"
    : `${paths.home}/Applications/${sender === "pi" ? "Pi" : "Codex"} Notifier.app/Contents/MacOS/terminal-notifier`;
  return { executable, args, summaryKey };
}
