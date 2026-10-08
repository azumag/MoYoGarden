import { bindings, defineConfig, exports } from "cf/config";

/**
 * MoYoGarden の Cloudflare 設定（cf-first / Issue #46）。
 *
 * `wrangler.jsonc` と `wrangler.pbr.jsonc` を 1 ファイルへ統合した検証用の正本です。
 * - 既定（`--mode` なし）: production Worker `moyo-garden`
 * - `--mode pbr-preview`: `moyo-garden-pbr-preview`（PBR プレビュー専用の隔離 Worker）
 *
 * cf は「返した `worker.name` が変わったときだけ別 Worker をデプロイする」ため、
 * プレビュー隔離は mode 分岐で再現します。
 *
 * cf の Wrangler bundler が読むビルド設定（custom build hook / source map /
 * static assets directory / 型生成の無効化）は `wrangler.config.ts` 側にあります。
 */

const COMPATIBILITY_DATE = "2026-08-28";

/** 両 Worker 共通の Durable Object クラス宣言（Wrangler `migrations` v1 の置換）。 */
const durableObjectExports = {
	RegionDurableObject: exports.durableObject({ storage: "sqlite" }),
};

export default defineConfig(({ mode }) => {
	if (mode === "pbr-preview") {
		// `wrangler.pbr.jsonc` と同値。routes なし・workers.dev 有効・preview URL 無効。
		return {
			worker: {
				name: "moyo-garden-pbr-preview",
				compatibilityDate: COMPATIBILITY_DATE,
				entrypoint: "src/worker.ts",
				observability: { enabled: true, headSamplingRate: 0.1 },
				assets: {
					notFoundHandling: "single-page-application",
					runWorkerFirst: ["/api/*"],
				},
				workersDev: true,
				previewUrls: false,
				env: {
					DEFAULT_REGION_ID: bindings.text("garden-1"),
					REGION_IDS: bindings.text("garden-1"),
					WORLD_SEED: bindings.text("424242"),
					TICK_MS: bindings.text("10000"),
					OPEN_COMMANDS: bindings.text("false"),
					ASSETS: bindings.assets(),
					REGIONS: bindings.durableObject({
						worker: "moyo-garden-pbr-preview",
						exportName: "RegionDurableObject",
					}),
				},
				exports: durableObjectExports,
			},
		};
	}

	return {
		// `wrangler.jsonc` と同値。
		worker: {
			name: "moyo-garden",
			compatibilityDate: COMPATIBILITY_DATE,
			entrypoint: "src/arrival-registration-reliability-entry.ts",
			observability: { enabled: true, headSamplingRate: 0.1 },
			assets: {
				notFoundHandling: "single-page-application",
				runWorkerFirst: ["/api/*"],
			},
			// `routes: [{ pattern: "moyo.bluemoon.works", custom_domain: true }]`。
			domains: ["moyo.bluemoon.works"],
			env: {
				DEFAULT_REGION_ID: bindings.text("garden-1"),
				REGION_IDS: bindings.text("garden-1,garden-2,garden-3"),
				WORLD_SEED: bindings.text("424242"),
				TICK_MS: bindings.text("10000"),
				OPEN_COMMANDS: bindings.text("false"),
				ASSETS: bindings.assets(),
				REGIONS: bindings.durableObject({
					worker: "moyo-garden",
					exportName: "RegionDurableObject",
				}),
			},
			exports: durableObjectExports,
		},
	};
});
