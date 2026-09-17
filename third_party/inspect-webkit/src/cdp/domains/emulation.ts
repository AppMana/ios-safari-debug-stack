import type { Target } from "../target";
import { swallowWith } from "../domain";

export function installEmulationFilters(t: Target) {
  // ---- Emulation / Rendering renames -----------------------------------
  t.addMessageFilter("tools::Emulation.canEmulate", (msg) =>
    swallowWith(t, msg, { result: true }),
  );
  // Emulation.setTouchEmulationEnabled. WebKit removed
  // Page.setTouchEmulationEnabled; verified live against iOS 27.0
  // ("'Page.setTouchEmulationEnabled' was not found"), and there is no
  // replacement in the Page domain's overrideSetting enum. Forwarding it
  // produced a protocol error that Puppeteer treats as fatal: its
  // EmulationManager applies the default viewport on every new page, so
  // `browser.pages()` / `puppeteer.connect()` failed outright unless the
  // caller passed `defaultViewport: null`.
  //
  // The inspected device is a physical iPhone or iPad: touch input is
  // always present and cannot be turned off from the inspector. Ack the
  // command so viewport emulation completes; the touch capability of the
  // real device is unchanged either way.
  t.addMessageFilter("tools::Emulation.setTouchEmulationEnabled", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Emulation.setScriptExecutionDisabled", (msg) => {
    msg.method = "Page.setScriptExecutionDisabled";
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::Emulation.setEmulatedMedia", (msg) => {
    msg.method = "Page.setEmulatedMedia";
    return Promise.resolve(msg);
  });
  t.addMessageFilter("tools::Rendering.setShowPaintRects", (msg) => {
    msg.method = "Page.setShowPaintRects";
    return Promise.resolve(msg);
  });

  // Emulation.setDeviceMetricsOverride / clearDeviceMetricsOverride.
  // WebKit historically mapped these to Page.setScreenSizeOverride, but
  // iOS 26 has removed that method (verified live: "method not found").
  // Page.overrideSetting exists but doesn't accept a device-metrics
  // setting name. There is no working WIR equivalent on iOS 26 — swallow
  // so DevTools doesn't surface a "command failed" toast every time the
  // user toggles device emulation in the UI.
  t.addMessageFilter("tools::Emulation.setDeviceMetricsOverride", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Emulation.clearDeviceMetricsOverride", (msg) =>
    swallowWith(t, msg, {}),
  );

  // Emulation.setUserAgentOverride: DevTools' device toolbar sends the
  // override through the Emulation domain (the "Network conditions" panel
  // sends through Network — handled separately in network.ts). Both end
  // up at Page.overrideUserAgent in WIR with `{value: userAgent}`.
  t.addMessageFilter("tools::Emulation.setUserAgentOverride", (msg) => {
    const ua = msg.params?.userAgent ?? "";
    msg.method = "Page.overrideUserAgent";
    msg.params = { value: ua };
    return Promise.resolve(msg);
  });

  // Stubs DevTools probes on attach.
  t.addMessageFilter("tools::Emulation.setFocusEmulationEnabled", (msg) =>
    swallowWith(t, msg, {}),
  );
  t.addMessageFilter("tools::Emulation.setDefaultBackgroundColorOverride", (msg) =>
    swallowWith(t, msg, {}),
  );
}
