import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".pages-dist/**",
      "dist/**",
      "node_modules/**",
      "server/herdr-gui*",
      "server/public/**",
      "server/src/public-files.gen.ts",
      "web/dist/**",
      "web/node_modules/**",
      "server/node_modules/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.es2024,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}", "web/vite.config.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2024,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: ["site/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2024,
      },
    },
  },
  {
    files: ["server/src/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.bunBuiltin,
        ...globals.nodeBuiltin,
        ...globals.es2024,
      },
    },
  },
);
