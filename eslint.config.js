// ESLint flat config (ESM — package.json is "type": "module").
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", ".live/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // This is a JSON-on-the-wire proxy; `any`/`unknown` at the boundaries is
      // deliberate and pervasive. Keep it allowed rather than littering casts.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // Commented `catch {}` blocks are an intentional "best-effort, ignore" idiom.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // The doctor uses `cond ? ok(...) : fail(...)` as a terse status statement.
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true, allowShortCircuit: true }],
      // Zero-width spaces appear inside comments (to write a literal `*/`).
      "no-irregular-whitespace": ["error", { skipComments: true }],
    },
  },
  {
    // The launcher + install scripts are plain Node ESM, not typed sources.
    files: ["bin/**/*.mjs", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    rules: { "@typescript-eslint/no-unused-vars": "off", "no-undef": "off" },
  },
);
