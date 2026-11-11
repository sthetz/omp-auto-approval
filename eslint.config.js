import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // `() => call()` for a callback whose result nobody reads is fine; a void
      // result used as a value is still an error.
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      // Rules files load into plain records keyed by the file's own keys, and
      // a null entry deletes a default one; unsetting an environment variable
      // is delete process.env[name]. A Map would not fit either.
      "@typescript-eslint/no-dynamic-delete": "off",
      // String spreads here split into code points on purpose (glob characters,
      // option letters), not user-facing text; other misused spreads stay errors.
      "@typescript-eslint/no-misused-spread": ["error", { allow: [{ from: "lib", name: "string" }] }],

      // Without noUncheckedIndexedAccess, arr[i] and record[key] are typed as
      // always present, so this rule calls the checks on them unnecessary.
      // It is turned on together with that flag.
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  {
    // Test stubs implement OMP's async interfaces (classifierClient,
    // ui.select, getApiKeyAndHeaders) and mostly return at once.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
);
