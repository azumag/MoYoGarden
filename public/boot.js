(() => {
  "use strict";

  // This query key only bootstraps the commit-aware loader itself. Runtime
  // modules use /api/meta's deployed build.commit, so every production deploy
  // receives a new browser/CDN cache key without manually bumping app version.
  let VERSION = "commit-aware-1";
  const WATCHDOG_MS = 12_000;
  const ASSET_VERSION_TIMEOUT_MS = 1_500;
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

  const resolveAssetVersion = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ASSET_VERSION_TIMEOUT_MS);
    try {
      const url = new URL("/api/meta", location.origin);
      url.searchParams.set("region", "garden-1");
      url.searchParams.set("radius", "0");
      url.searchParams.set("boot", VERSION);
      const response = await fetch(url, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
        signal: controller.signal,
      });
      if (!response.ok) return VERSION;
      const payload = await response.json();
      const commit = payload?.build?.commit;
      if (typeof commit === "string" && /^[0-9a-f]{7,64}$/i.test(commit)) return commit;
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.warn("MoYoGarden: build commit lookup failed; using bootstrap cache key", error);
      }
    } finally {
      clearTimeout(timeout);
    }
    return VERSION;
  };

  const preload = (href) => {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = href;
    link.crossOrigin = "anonymous";
    document.head.append(link);
  };

  // Three.js is vendor-versioned independently and can be preloaded before the
  // deployed commit is known. All mutable client modules wait for VERSION.
  preload("/vendor/three-r185/build/three.module.min.js");

  const preloadRuntime = () => {
    preload(`/client/sky-fix.js?v=${VERSION}`);
    preload(`/client/hex-footprint-rendering.js?v=${VERSION}`);
    preload(`/client/seamless-navigation.js?v=${VERSION}`);
    preload(`/client/hex-neighbor-preview.js?v=${VERSION}`);
    preload(`/client/hex-tile-rendering.js?v=${VERSION}`);
    preload(`/client/hex-terrain-stitching.js?v=${VERSION}`);
    preload(`/client/agent-crowding.js?v=${VERSION}`);
    preload(`/client/decay-dressing.js?v=${VERSION}`);
    preload(`/client/atmosphere.js?v=${VERSION}`);
    preload(`/client/graphics-controls.js?v=${VERSION}`);
    preload(`/app.js?v=${VERSION}`);
  };

  const launch = async () => {
    VERSION = await resolveAssetVersion();
    window.__MOYO_PBR_BOOT__ = Object.freeze({ version: VERSION, startedAt: performance.now() });
    preloadRuntime();

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
    try {
      await import(`/client/agent-crowding.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: BOT crowd separation failed; keeping centered agent rendering", error);
    }
    try {
      await import(`/client/decay-dressing.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: decay dressing failed; continuing without ruined-world details", error);
    }

    try {
      await import(`/client/atmosphere.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: atmosphere enhancement failed; keeping base materials", error);
    }
    try {
      await import(`/client/graphics-controls.js?v=${VERSION}`);
    } catch (error) {
      console.warn("MoYoGarden: graphics controls failed; keeping base renderer", error);
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
