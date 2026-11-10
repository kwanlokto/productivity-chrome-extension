// Focus Guard — the "blocks again in 0:42" bar on an unlocked site. The
// background injects this (chrome.scripting) into the site's tabs when the
// unlock's last minute starts, again for each new page on the site in that
// minute. After that it follows the unlock from storage by itself: it hides
// after "+1 min" lifts the unlock out of its last minute, comes back when the
// last minute starts again, and goes away when the unlock ends or Focus Guard is
// switched off.
//
// Classic script: it can't import, so it keeps its own copies of WARNING_MS
// (shared/core.js), the snooze-entry readers (expiryOf / capOf), and the popup's
// colours (popup/popup.css). Keep them in sync by hand.

(() => {
  // Injected again into a page that already has the bar (a new unlock, or a
  // same-page navigation): just re-read the state.
  if (window.__focusGuardWarning) {
    window.__focusGuardWarning.refresh();
    return;
  }

  const WARNING_MS = 59_000;
  const TICK_MS = 250;

  const expiryOf = (e) => (typeof e === "number" ? e : e.expiry);
  const startOf = (e) => (typeof e === "object" && e.start ? e.start : null);
  const capOf = (e) =>
    typeof e === "object" && e.cap ? e.cap : expiryOf(e) - (startOf(e) ?? 0);
  const unlockKey = (e) => startOf(e) ?? expiryOf(e);

  const host = location.hostname.toLowerCase().replace(/^www\./, "");

  // The unlock this page's site is under, if any.
  let domain = null;
  let entry = null;
  let paused = false;
  // unlockKey of the unlock the user dismissed the bar for, here.
  let dismissedKey = null;
  let timer = null;

  /* --------------------------------- Markup -------------------------------- */

  // A shadow root keeps the site's CSS off the bar and the bar's CSS off the site.
  const holder = document.createElement("focus-guard-warning");
  holder.style.cssText =
    "all: initial; position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;";
  const root = holder.attachShadow({ mode: "open" });
  // A constructed stylesheet, not a <style> tag: pages with a strict Content
  // Security Policy (common on the sites people block) can block <style> tags.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    height: 40px;
    max-width: calc(100vw - 24px);
    padding: 0 6px 0 14px;
    border-radius: 999px;
    border: 1px solid #dde3ec;
    background: #ffffff;
    color: #111827;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
    font: 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, sans-serif;
    white-space: nowrap;
  }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #dc2626; }
  .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .domain { font-weight: 600; }
  .time { font-weight: 700; color: #b91c1c; font-variant-numeric: tabular-nums; }
  button { font: inherit; color: inherit; cursor: pointer; }
  .more {
    flex: none;
    height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid rgba(220, 38, 38, 0.45);
    background: transparent;
    font-weight: 600;
  }
  .more:not(:disabled):hover { background: rgba(220, 38, 38, 0.08); }
  .more:disabled { opacity: 0.4; cursor: default; }
  .close {
    flex: none;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: #5b6577;
  }
  .close:hover { background: rgba(15, 23, 42, 0.06); color: #111827; }
  .close svg { width: 14px; height: 14px; }
  :focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (prefers-color-scheme: dark) {
    .bar {
      border-color: #263045;
      background: #171e2e;
      color: #e6e9ef;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }
    .time { color: #f87171; }
    .close { color: #8e99ad; }
    .close:hover { background: rgba(255, 255, 255, 0.08); color: #e6e9ef; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .bar { animation: fg-in 0.2s ease-out; }
    @keyframes fg-in { from { opacity: 0; transform: translateY(-8px); } }
  }

  `);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `
    <div class="bar" role="region" aria-label="Focus Guard">
      <span class="dot" aria-hidden="true"></span>
      <span class="text" aria-hidden="true"><span class="domain"></span> blocks again in <span class="time"></span></span>
      <span class="sr" role="status"></span>
      <button type="button" class="more">+1 min</button>
      <button type="button" class="close" aria-label="Hide this warning" title="Hide">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`;

  const domainEl = root.querySelector(".domain");
  const timeEl = root.querySelector(".time");
  const statusEl = root.querySelector(".sr");
  const moreBtn = root.querySelector(".more");
  const closeBtn = root.querySelector(".close");

  /* -------------------------------- Behaviour ------------------------------ */

  /** m:ss, matching the popup's clock. */
  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  /**
   * Message the background. Fails quietly once the extension has been reloaded
   * or removed, which leaves this script orphaned on the page.
   * @param {string} type
   */
  function send(type) {
    try {
      return chrome.runtime.sendMessage({ type }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /** Show, update, or hide the bar for the current moment. */
  function render() {
    const remaining = entry ? expiryOf(entry) - Date.now() : 0;
    const show =
      entry && !paused && dismissedKey !== unlockKey(entry) &&
      remaining > 0 && remaining <= WARNING_MS;
    if (!show) {
      if (holder.isConnected) holder.remove();
      return;
    }
    domainEl.textContent = domain;
    timeEl.textContent = formatClock(remaining);
    // "+1 min" can't take the unlock past its original length.
    moreBtn.disabled = remaining >= capOf(entry) - 1500;
    if (!holder.isConnected) {
      document.documentElement.append(holder);
      // Announced once, rather than every second the clock ticks.
      statusEl.textContent = "";
      setTimeout(() => {
        statusEl.textContent = `${domain} is blocked again in under a minute.`;
      }, 100);
    }
  }

  /** Re-read the unlock and the on/off state, then render. */
  async function refresh() {
    let snoozed, pausedUntil;
    try {
      ({ snoozed = {}, pausedUntil = 0 } = await chrome.storage.local.get(["snoozed", "pausedUntil"]));
    } catch {
      snoozed = {};
    }
    domain = Object.keys(snoozed).find((d) => host === d || host.endsWith("." + d)) || null;
    entry = domain ? snoozed[domain] : null;
    paused = pausedUntil > Date.now();

    // Tick only while there's an unlock to follow.
    if (entry && !timer) timer = setInterval(render, TICK_MS);
    if (!entry && timer) {
      clearInterval(timer);
      timer = null;
    }
    render();
  }

  moreBtn.addEventListener("click", async () => {
    moreBtn.disabled = true;
    await send("fg-extend-unlock"); // the storage change re-renders
  });
  closeBtn.addEventListener("click", () => {
    if (entry) dismissedKey = unlockKey(entry);
    render();
    send("fg-dismiss-warning");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.snoozed || changes.pausedUntil)) refresh();
  });

  window.__focusGuardWarning = { refresh };
  refresh();
})();
