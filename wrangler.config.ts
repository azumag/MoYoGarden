import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
	uploadSourceMaps: true,
	build: {
		command: "node scripts/wrangler-build.mjs",
	},
	types: {
		generate: false,
	},
	assetsDirectory: "./public",
});
