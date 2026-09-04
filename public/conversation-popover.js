const CONVERSATION_PATTERN = /^(.+?) to (.+?): "(.+)"$/;

export function parseConversationEventText(text) {
  const match = CONVERSATION_PATTERN.exec(String(text || "").trim());
  if (!match) return undefined;
  const [, speaker, listener, line] = match;
  if (!speaker || !listener || !line) return undefined;
  return { speaker, listener, line };
}

function ensurePopover() {
  let popover = document.querySelector("#conversation-popover");
  if (popover) return popover;

  const style = document.createElement("style");
  style.textContent = `
    #conversation-popover {
      position: fixed;
      left: 50%;
      bottom: max(76px, calc(env(safe-area-inset-bottom) + 62px));
      z-index: 45;
      width: min(440px, calc(100vw - 28px));
      padding: 10px 14px 11px;
      border: 1px solid rgba(255,255,255,.22);
      border-radius: 16px 16px 16px 5px;
      background: rgba(20, 28, 25, .86);
      color: #f6fff9;
      box-shadow: 0 12px 30px rgba(0,0,0,.24);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      pointer-events: none;
      opacity: 0;
      transform: translate(-50%, 8px) scale(.98);
      transition: opacity 180ms ease, transform 180ms ease;
    }
    #conversation-popover[data-visible="true"] {
      opacity: 1;
      transform: translate(-50%, 0) scale(1);
    }
    #conversation-popover .conversation-speakers {
      display: block;
      margin-bottom: 3px;
      font: 700 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: .08em;
      color: #c8ff66;
      text-transform: uppercase;
    }
    #conversation-popover .conversation-line {
      display: block;
      font: 600 13px/1.45 system-ui, -apple-system, sans-serif;
    }
    @media (max-width: 680px) {
      #conversation-popover {
        bottom: max(58px, calc(env(safe-area-inset-bottom) + 48px));
        background: rgba(20, 28, 25, .94);
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      #conversation-popover { transition: none; }
    }
  `;
  document.head.append(style);

  popover = document.createElement("div");
  popover.id = "conversation-popover";
  popover.setAttribute("role", "status");
  popover.setAttribute("aria-live", "polite");
  popover.innerHTML = '<span class="conversation-speakers"></span><span class="conversation-line"></span>';
  document.body.append(popover);
  return popover;
}

export function observeConversationFeed(eventList, options = {}) {
  if (!eventList || typeof MutationObserver === "undefined") return () => {};

  const popover = ensurePopover();
  const speakers = popover.querySelector(".conversation-speakers");
  const line = popover.querySelector(".conversation-line");
  const seen = new Set();
  const maxSeen = Math.max(12, options.maxSeen || 96);
  const visibleMs = Math.max(1_500, options.visibleMs || 4_600);
  let hideTimer;

  const remember = (key) => {
    seen.add(key);
    while (seen.size > maxSeen) seen.delete(seen.values().next().value);
  };

  const scan = () => {
    const items = [...eventList.querySelectorAll("li")];
    for (const item of items) {
      const time = item.querySelector("time")?.textContent || "";
      const message = item.textContent.slice(time.length).trim();
      const parsed = parseConversationEventText(message);
      if (!parsed) continue;
      const key = `${time}|${message}`;
      if (seen.has(key)) continue;
      remember(key);
      speakers.textContent = `${parsed.speaker} → ${parsed.listener}`;
      line.textContent = parsed.line;
      popover.dataset.visible = "true";
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { popover.dataset.visible = "false"; }, visibleMs);
      break;
    }
  };

  const observer = new MutationObserver(scan);
  observer.observe(eventList, { childList: true });
  scan();
  return () => {
    observer.disconnect();
    clearTimeout(hideTimer);
    popover.dataset.visible = "false";
  };
}

function initializeConversationPopover() {
  const eventList = document.querySelector("#event-list");
  if (eventList) observeConversationFeed(eventList);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeConversationPopover, { once: true });
  } else {
    initializeConversationPopover();
  }
}
