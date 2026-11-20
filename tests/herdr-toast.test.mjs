import assert from "node:assert/strict";
import test from "node:test";
import { formatHerdrSummary } from "../extensions/macos-notify.ts";
import { planToast } from "../herdr/macos-toast/route.mjs";

const address = "macmini/t6";
const paths = { home: "/Users/test", appHome: "/a path/with 'quotes'" };
const toast = { title: "Agent finished", body: "Projects / Agent", level: "info", action: { name: "agent.focus", args: { terminal: address } } };
const msg = Buffer.from(formatHerdrSummary("Работа завершена.").match(/:msg=([^\x1b]+)/)[1], "base64").toString();
const info = { address, status: "done", report: { app: "pi" }, records: { "pi-notify-summary": { state: "done", app: "pi", msg } } };
const field = (plan, flag) => plan.args[plan.args.indexOf(flag) + 1]?.slice(1);

test("a matching Pi completion uses the Pi sender and its named summary exactly once", () => {
  const seen = new Set();
  const plan = planToast(toast, info, paths, seen);
  assert.match(plan.executable, /\/Pi Notifier\.app\//);
  assert.equal(field(plan, "-message"), "Работа завершена.");
  assert.equal(field(plan, "-subtitle"), toast.body);
  assert.match(field(plan, "-execute"), /macmini\/t6/);
  seen.add(plan.summaryKey);
  assert.equal(field(planToast(toast, info, paths, seen), "-message"), toast.body);
});

test("Codex ignores Pi records and uses its own sender regardless of the toast title", () => {
  for (const rec of [{ ...info, report: { app: "codex" } }, { ...info, report: {}, program: { key: "codex" } }]) {
    const plan = planToast({ ...toast, title: "Pi finished" }, rec, paths, new Set());
    assert.match(plan.executable, /\/Codex Notifier\.app\//);
    assert.equal(field(plan, "-message"), toast.body);
  }
});

test("mismatched and blocked toasts cannot pick up an old Pi summary", () => {
  for (const rec of [{ ...info, status: "blocked" }, { ...info, address: "t17" }, { ...info, records: {} }]) {
    assert.equal(field(planToast(toast, rec, paths, new Set()), "-message"), toast.body);
  }
});

test("unknown and service notifications never get the Pi icon", () => {
  const generic = planToast(toast, { ...info, report: { app: "something-else" } }, paths, new Set());
  assert.equal(generic.executable, "/opt/homebrew/bin/terminal-notifier");
  const service = planToast({ title: "Herdr saved" }, null, paths, new Set());
  assert.equal(service.executable, generic.executable);
});

test("login toasts and unsupported click actions stay inside Herdr", () => {
  assert.equal(planToast({ title: "Herdr", body: "macmini needs login; run hc machine login macmini" }, null, paths, new Set()), null);
  assert.equal(planToast({ ...toast, action: { name: "agent.focus", args: { terminal: "t6;touch bad" } } }, info, paths, new Set()), null);
});
