(() => {
  "use strict";

  const VERSION = "0.3.11";
  const WATCHDOG_MS = 12_000;
  const PRODUCTION_URL = "https://moyo.bluemoon.works/";
  const params = new URLSearchParams(location.search);
  const loading = document.querySelector("#loading");
  const label = document.querySelector("#loading-label");
  const detail = document.querySelector("#loading-detail");
  const progress = document.querySelector("#loading-progress");
  let ready = false;
  let fallingBack = false;

  const setMessage = (message, submessage = "") => {
    if (label) label.textContent = message;
    if (detail) detail.textContent = submessage;
  };

  const stableFallback = (reason) => {
    if (ready || fallingBack) return;
    fallingBack = true;
    const message = reason instanceof Error ? reason.message : String(reason || "unknown startup failure");
    console.error("MoYoGarden PBR startup fallback:", message);
    setMessage("3Dレンダラーを起動できませんでした", "Balanced品質で再読み込みできます");

    const productionHost = new URL(PRODUCTION_URL).host;
    if (location.host !== productionHost) {
      const destination = new URL(PRODUCTION_URL);
      destination.searchParams.set("pbrFallback", VERSION);
      destination.searchParams.set("reason", message.slice(0, 120));
      setTimeout(() => location.replace(destination), 250);
      return;
    }

    if (progress) progress.hidden = true;
    if (detail) {
      const destination = new URL(location.href);
      destination.searchParams.set("quality", "balanced");
      destination.searchParams.delete("safe");
      destination.searchParams.delete("renderer");
      const link = document.createElement("a");
      link.href = destination.href;
      link.textContent = "Balancedで再読み込み";
      link.className = "loading-fallback-link";
      detail.replaceChildren(document.createTextNode(`${message} — `), link);
    }
  };

  const compatibilityRequested = params.get("renderer") === "compat"
    || params.get("quality") === "low"
    || params.get("safe") === "1";

  window.__MOYO_PBR_BOOT__ = Object.freeze({ version: VERSION, startedAt: performance.now() });
  window.addEventListener("moyo:pbr-ready", () => {
    ready = true;
    if (loading) loading.classList.add("hidden");
  }, { once: true });
  window.addEventListener("moyo:pbr-error", (event) => {
    stableFallback(event.detail?.error || event.detail || "renderer error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (!ready) stableFallback(event.reason || "unhandled module rejection");
  });
  window.addEventListener("error", (event) => {
    if (!ready) stableFallback(event.error || event.message || "module script error");
  }, true);

  const preload = (href) => {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = href;
    link.crossOrigin = "anonymous";
    document.head.append(link);
  };
  preload("/vendor/three-r185/build/three.module.min.js");
  preload(`/client/sky-fix.js?v=${VERSION}`);
  preload(`/client/decay-dressing.js?v=${VERSION}`);
  preload(`/client/hex-footprint-rendering.js?v=${VERSION}`);
  preload(`/client/seamless-navigation.js?v=${VERSION}`);
  preload(`/client/hex-neighbor-preview.js?v=${VERSION}`);
  preload(`/client/hex-tile-rendering.js?v=${VERSION}`);
  preload(`/client/hex-terrain-stitching.js?v=${VERSION}`);
  preload(`/app.js?v=${VERSION}`);

  const launch = async () => {
    if (compatibilityRequested) {
      setMessage("軽量セーフモードで起動しています", "描画負荷を抑えて3Dワールドを起動します");
    } else {
      setMessage("3Dレンダラーを起動しています", "軽量表示の後、退廃ディテール・authored BOT・建物・自然物・PBR・影を段階的に追加します");
    }
    try {
      await import(`/client/sky-fix.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: sky backdrop patch failed; continuing with base renderer", error);
    }
    try {
      await import(`/client/decay-dressing.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: decay dressing failed; continuing without ruined-world details", error);
    }
    try {
      await import(`/client/hex-footprint-rendering.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: hex footprint clipping failed; keeping rectangular rendering", error);
    }
    try {
      await import(`/client/seamless-navigation.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: seamless navigation extension failed; keeping local camera bounds", error);
    }
    try {
      await import(`/client/hex-neighbor-preview.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: hex neighbor preview failed; keeping physical neighbor placement", error);
    }
    try {
      await import(`/client/hex-tile-rendering.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: hex tile rendering failed; keeping legacy tile renderer", error);
    }
    try {
      await import(`/client/hex-terrain-stitching.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: hex terrain boundary stitching failed; keeping native chunk heights", error);
    }

    const moduleScript = document.createElement("script");
    moduleScript.type = "module";
    moduleScript.src = `/app.js?v=${VERSION}`;
    moduleScript.addEventListener("error", () => stableFallback("PBR module graph failed to load"), { once: true });
    document.body.append(moduleScript);
  };

  void launch();

  setTimeout(() => {
    if (!ready) stableFallback(`startup watchdog exceeded ${WATCHDOG_MS}ms`);
  }, WATCHDOG_MS);
})();
