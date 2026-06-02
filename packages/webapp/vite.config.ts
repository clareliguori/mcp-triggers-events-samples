import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const packageRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Dev-only middleware that serves a gitignored `config.local.json` (at the
 * webapp package root) in place of the committed `static/config.json`.
 *
 * The webapp loads its runtime config by fetching `/config.json` (see
 * `src/lib/auth/config.ts`). The committed `static/config.json` carries local
 * dev placeholders. To point the dev server at a real deployed backend for
 * end-to-end testing, create `packages/webapp/config.local.json` (gitignored)
 * with the real Cognito/Data API values — this middleware serves it at
 * `/config.json` so you never edit (and never have to revert) the committed
 * placeholder file, and the real values can never be committed.
 *
 * This only runs under `vite dev`. The production build (`vite build`) does not
 * include `config.local.json` (it lives outside `static/`), so deployed assets
 * are unaffected and WebappStack still injects deploy-time values.
 */
function localConfigOverride(): Plugin {
  return {
    name: "webapp-local-config-override",
    apply: "serve",
    configureServer(server) {
      const localConfigPath = resolve(packageRoot, "config.local.json");
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url !== "/config.json" || !existsSync(localConfigPath)) {
          next();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        res.end(readFileSync(localConfigPath));
      });
    },
  };
}

export default defineConfig({
  plugins: [localConfigOverride(), tailwindcss(), sveltekit()],
});
