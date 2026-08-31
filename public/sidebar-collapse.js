(() => {
  const sidebar = document.querySelector("#sidebar");
  const toggle = document.querySelector("#sidebar-toggle");
  if (!sidebar || !toggle) return;

  const mobileViewport = window.matchMedia("(max-width: 680px)");
  const storageKey = "moyogarden.sidebarCollapsed";
  let savedChoice = null;

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "true" || stored === "false") {
      savedChoice = stored === "true";
    }
  } catch {
    // localStorage may be unavailable in strict/private browsing modes.
  }

  function setCollapsed(collapsed) {
    sidebar.classList.toggle("is-collapsed", collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", collapsed ? "情報パネルを開く" : "情報パネルを畳む");
    toggle.textContent = collapsed ? "情報を表示 ▲" : "畳む ▼";
  }

  function applyViewportState() {
    if (mobileViewport.matches) {
      setCollapsed(savedChoice ?? true);
    } else {
      setCollapsed(false);
    }
  }

  toggle.addEventListener("click", () => {
    if (!mobileViewport.matches) return;

    const collapsed = !sidebar.classList.contains("is-collapsed");
    savedChoice = collapsed;
    try {
      window.localStorage.setItem(storageKey, String(collapsed));
    } catch {
      // The UI still works for this page even when the preference cannot persist.
    }
    setCollapsed(collapsed);
  });

  if (typeof mobileViewport.addEventListener === "function") {
    mobileViewport.addEventListener("change", applyViewportState);
  } else if (typeof mobileViewport.addListener === "function") {
    mobileViewport.addListener(applyViewportState);
  }

  applyViewportState();
})();
