import { defineConfig } from "vitest/config";

// Unit/property tests for the framework-agnostic auth logic (PKCE, JWT decode,
// Cognito URL/token helpers, config normalization). These modules avoid
// SvelteKit `$app/*` aliases so they run under plain Node without the Svelte
// build pipeline. Component/store tests that depend on `$app/*` are exercised
// via `npm run build`/`npm run check` and manual inspection instead.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
