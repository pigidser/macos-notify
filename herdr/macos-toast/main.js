import { div } from "gpui-kit";
import { appHome, checking, closeOverlay, exec, home, props, terminals } from "herdr";
import Toast from "./in-app-toast.js";
import { agentAddress, planToast } from "./route.mjs";

const seen = new Set();

export default class MacOSToast extends Toast {
  init(_props, cx) {
    const p = props() ?? {};
    if (checking() || !p.overlay) return;
    const address = agentAddress(p);
    const info = address ? terminals().find(t => t.address === address) : null;
    const plan = planToast(p, info, { appHome: appHome(), home: home() }, seen);
    if (!plan) return;

    if (plan.summaryKey) {
      seen.add(plan.summaryKey);
      if (seen.size > 128) seen.delete(seen.values().next().value);
    }
    this.delivering = true;
    cx.spawn(async (cx) => {
      try {
        const result = await exec(plan.executable, plan.args, { timeout: 3500 });
        if (result.code === 0) {
          closeOverlay(p.overlay);
          return;
        }
      } catch { /* Fall back to Herdr's original toast. */ }
      if (plan.summaryKey) seen.delete(plan.summaryKey);
      this.delivering = false;
      cx.notify();
    });
  }

  render(cx) {
    return this.delivering ? div() : super.render(cx);
  }
}
