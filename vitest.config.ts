import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "../pi/node_modules/vitest/dist/config.js";

function piPath(rel: string): string {
	return fileURLToPath(new URL(`../pi/${rel}`, import.meta.url));
}

const VIRTUAL_MODEL_DATA_PREFIX = "\0pi-swarm-empty-model-data:";
const VIRTUAL_DEP_PREFIX = "\0pi-swarm-missing-dep:";

function missingPiDepsFallbackPlugin() {
	return {
		name: "pi-swarm-missing-pi-deps-fallback",
		enforce: "pre" as const,
		resolveId(source: string, importer?: string) {
			if (!importer) {
				return undefined;
			}
			const normalizedImporter = importer.replace(/\\/g, "/");
			if (source === "marked-cjk-friendly" && normalizedImporter.includes("/packages/tui/")) {
				if (!existsSync(piPath("node_modules/marked-cjk-friendly"))) {
					return `${VIRTUAL_DEP_PREFIX}marked-cjk-friendly.mjs`;
				}
			}
			if (source === "lovely-mermaid" && normalizedImporter.includes("/packages/coding-agent/")) {
				if (!existsSync(piPath("node_modules/lovely-mermaid"))) {
					return `${VIRTUAL_DEP_PREFIX}lovely-mermaid.mjs`;
				}
			}
			if (!source.endsWith(".json") || !normalizedImporter.includes("/packages/ai/src/providers/")) {
				return undefined;
			}
			const candidate = resolve(dirname(importer), source);
			if (existsSync(candidate)) {
				return undefined;
			}
			const isManifest = source.endsWith(".manifest.json");
			return `${VIRTUAL_MODEL_DATA_PREFIX}${isManifest ? "manifest" : "provider"}:${candidate}.mjs`;
		},
		load(id: string) {
			if (id === `${VIRTUAL_DEP_PREFIX}marked-cjk-friendly.mjs`) {
				return "export default function markedCjkFriendly() { return {}; }";
			}
			if (id === `${VIRTUAL_DEP_PREFIX}lovely-mermaid.mjs`) {
				return 'export function render() { return { lines: [] }; }\nexport function toAnsi() { return ""; }';
			}
			if (!id.startsWith(VIRTUAL_MODEL_DATA_PREFIX)) {
				return undefined;
			}
			if (id.startsWith(`${VIRTUAL_MODEL_DATA_PREFIX}manifest:`)) {
				return `export default ${JSON.stringify({
					schemaVersion: 6,
					generatedAt: "",
					structureHash: "",
					files: {},
				})};`;
			}
			return "export default {};";
		},
	};
}

export default defineConfig({
	plugins: [missingPiDepsFallbackPlugin()],
	test: {
		globals: false,
		environment: "node",
		testTimeout: 30000,
		env: { PI_OFFLINE: "1" },
		unstubEnvs: true,
		include: ["test/**/*.test.ts"],
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: piPath("packages/telemetry/src/index.ts") },
			{
				find: /^@earendil-works\/pi-telemetry\/testing$/,
				replacement: piPath("packages/telemetry/src/testing/index.ts"),
			},
			{ find: /^@earendil-works\/pi-schema$/, replacement: piPath("packages/schema/src/index.ts") },
			{ find: /^@earendil-works\/pi-schema\/formats$/, replacement: piPath("packages/schema/src/formats/index.ts") },
			{ find: /^@earendil-works\/pi-codemode$/, replacement: piPath("packages/codemode/src/index.ts") },
			{
				find: /^@earendil-works\/pi-codemode\/declarations$/,
				replacement: piPath("packages/codemode/src/declarations.ts"),
			},
			{ find: /^@earendil-works\/pi-codemode\/source$/, replacement: piPath("packages/codemode/src/source.ts") },
			{ find: /^@earendil-works\/pi-mcp$/, replacement: piPath("packages/mcp/src/index.ts") },
			{ find: /^@earendil-works\/pi-mcp\/oauth$/, replacement: piPath("packages/mcp/src/oauth/index.ts") },
			{ find: /^@earendil-works\/pi-mcp\/testing$/, replacement: piPath("packages/mcp/src/testing/index.ts") },
			{ find: /^@earendil-works\/pi-env$/, replacement: piPath("packages/env/src/index.ts") },
			{
				find: /^@earendil-works\/pi-ai$/,
				replacement: piPath("packages/coding-agent/src/core/extensions/pi-ai-extension-view.ts"),
			},
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: piPath("packages/ai/src/compat.ts") },
			{ find: /^@earendil-works\/pi-ai\/models$/, replacement: piPath("packages/ai/src/models.ts") },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: piPath("packages/ai/src/oauth.ts") },
			{ find: /^@earendil-works\/pi-ai\/utils\/(.+)$/, replacement: `${piPath("packages/ai/src/utils")}/$1.ts` },
			{ find: /^@earendil-works\/pi-ai\/api\/(.+)$/, replacement: `${piPath("packages/ai/src/api")}/$1.ts` },
			{
				find: /^@earendil-works\/pi-ai\/providers\/(.+)$/,
				replacement: `${piPath("packages/ai/src/providers")}/$1.ts`,
			},
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: piPath("packages/agent/src/index.ts") },
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: piPath("packages/coding-agent/src/index.ts") },
			{ find: /^@earendil-works\/pi-tui$/, replacement: piPath("packages/tui/src/index.ts") },
			{ find: /^typebox$/, replacement: piPath("node_modules/typebox/build/index.mjs") },
			{ find: /^typebox\/compile$/, replacement: piPath("node_modules/typebox/build/compile/index.mjs") },
			{ find: /^typebox\/value$/, replacement: piPath("node_modules/typebox/build/value/index.mjs") },
			{ find: /^vitest$/, replacement: piPath("node_modules/vitest/dist/index.js") },
		],
	},
});
