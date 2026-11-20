import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import register, { finalAnswerText, formatHerdrSummary, loadFastReferences } from "../extensions/macos-notify.ts";

const model = { provider: "openai-codex", id: "gpt-6-luna" };
const answer = text => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
const decode = report => JSON.parse(Buffer.from(report.match(/:msg=([^\x1b]+)\x1b\\$/)[1], "base64").toString());

function session({ tty = true, env = { HC_TERMINAL_ID: "t7" }, mode = "tui", result = () => answer("**Готово!**") } = {}) {
  const handlers = new Map(), writes = [], requests = [];
  const ctx = { cwd: "/tmp", isProjectTrusted: () => false, mode, modelRegistry: {
    getAvailable: () => [model],
    streamSimple(ref, input, options) {
      requests.push({ ref, input, options });
      return { result };
    },
  } };
  register({ on: (event, handler) => handlers.set(event, handler) }, { isTTY: tty, write: s => writes.push(s) }, env);
  const emit = (event, value = {}) => handlers.get(event)(value, ctx);
  return { emit, writes, requests };
}

test("only final text is used, and only for completed assistant responses", () => {
  const response = answer("final");
  response.content.unshift({ type: "text", text: "progress", textSignature: '{"phase":"commentary"}' });
  assert.equal(finalAnswerText(response), "final");
  assert.equal(finalAnswerText({ ...response, stopReason: "error" }), "");
});

test("Fast routes respect project trust and keep the original fallback", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-herdr-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await loadFastReferences(dir, true, dir), [{ provider: model.provider, model: model.id, priority: 1 }]);
  await mkdir(join(dir, ".pi"));
  await writeFile(join(dir, ".pi/pi-shift-router.json"), '{"tiers":{"fast":{"models":[]}}}');
  assert.equal((await loadFastReferences(dir, false, dir)).length, 1);
  assert.deepEqual(await loadFastReferences(dir, true, dir), []);
});

test("summary is a bounded, escaped OSC 7501 named record (never a root status)", () => {
  const formatted = formatHerdrSummary("\u001b\u0007🙂".repeat(400));
  assert.match(formatted, /^\x1b\]7501;state=done:id=pi-notify-summary:app=pi:msg=[\w+/=]+\x1b\\$/);
  const payload = decode(formatted);
  assert.equal([...payload.text].length, 250);
  assert.doesNotMatch(payload.text, /[\x1b\x07]/);
  assert.equal(formatHerdrSummary("\n \x07"), "");
});

test("settled writes one plain-text summary and forwards no model output during the run", async () => {
  const s = session();
  s.emit("agent_start");
  s.emit("message_end", { message: answer("Работа завершена.") });
  assert.deepEqual(s.writes, ["\x1b]7501;state=clear:id=pi-notify-summary\x1b\\"]);
  await s.emit("agent_settled");
  await s.emit("agent_settled");
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].options.reasoning, "minimal");
  assert.equal(decode(s.writes[1]).text, "Готово!");
  assert.equal(s.writes.length, 2);
});

for (const [name, opts] of Object.entries({ noHerdr: { env: {} }, redirected: { tty: false }, child: { env: { HC_TERMINAL_ID: "t7", PI_SUBAGENT_CHILD: "1" } }, print: { mode: "print" } })) {
  test(`${name}: no record or model call`, async () => {
    const s = session(opts);
    s.emit("agent_start");
    s.emit("message_end", { message: answer("ignored") });
    await s.emit("agent_settled");
    assert.deepEqual(s.writes, []);
    assert.deepEqual(s.requests, []);
  });
}

test("abort and failed model never publish a summary", async () => {
  const s = session({ result: async () => { throw new Error("unavailable"); } });
  s.emit("message_end", { message: answer("cancelled") });
  await s.emit("agent_settled", { aborted: true });
  assert.equal(s.requests.length, 0);
  s.emit("agent_start");
  s.emit("message_end", { message: answer("fail") });
  await s.emit("agent_settled");
  assert.equal(s.writes.length, 1);
  assert.equal(s.requests.length, 1);
});

test("shutdown cancels in-flight summarization and clears the named record", async () => {
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const s = session({ result: () => { start(); return new Promise(() => {}); } });
  s.emit("message_end", { message: answer("will cancel") });
  const run = s.emit("agent_settled");
  await started;
  s.emit("session_shutdown");
  await run;
  assert.equal(s.requests[0].options.signal.aborted, true);
  assert.deepEqual(s.writes, ["\x1b]7501;state=clear:id=pi-notify-summary\x1b\\"]);
});
