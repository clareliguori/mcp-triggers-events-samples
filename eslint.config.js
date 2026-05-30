// @ts-check
/**
 * ESLint flat configuration for the MCP Events Serverless Agent monorepo.
 *
 * This is an ESM TypeScript monorepo (Node 20+, NodeNext modules) using vitest
 * + fast-check. We use the typescript-eslint recommended + type-checked rule
 * sets, with type information resolved automatically via `projectService` (each
 * package's own tsconfig is discovered relative to the linted file).
 *
 * Conventions encoded here:
 * - Unused identifiers prefixed with `_` are intentional (matches the
 *   `noUnusedLocals`/`noUnusedParameters` carve-outs used across the code).
 * - Test files (`*.test.ts`) relax a few type-aware rules that are noisy when
 *   building synthetic fixtures and asserting against `unknown` shapes.
 */

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // Build artifacts, generated output, and non-source assets.
  {
    ignores: [
      "**/dist/**",
      "**/cdk.out/**",
      "**/*.tsbuildinfo",
      "**/node_modules/**",
      "packages/cdk/cdk.context.json",
      // The webapp is a not-yet-initialized SvelteKit stub (see task 12.1);
      // lint it once it has real source + its own tooling.
      "packages/webapp/**",
      "eslint.config.js",
    ],
  },

  // Base JS + type-aware TypeScript rule sets, applied to TS sources.
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        // Resolve each file's nearest tsconfig automatically (monorepo-aware).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow intentionally-unused identifiers when prefixed with `_`, and
      // ignore the rest-sibling pattern used to drop fields (e.g. omitting
      // `encryptedSecret` before returning a record).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Test files: relax type-aware rules that are noisy around synthetic
  // fixtures, `unknown` assertions, and mock clients.
  {
    files: ["**/*.test.ts", "**/*.property.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      // Mock implementations are frequently `async` to match the signature of
      // the function they stand in for, even when they have no `await`.
      "@typescript-eslint/require-await": "off",
    },
  },
);
