import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Build the app as a static SPA suitable for S3 + CloudFront.
    // A fallback page (index.html) enables client-side routing for all paths.
    adapter: adapter({
      fallback: "index.html",
      precompress: false,
      strict: true,
    }),
  },
};

export default config;
