// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `any` is a deliberate, documented choice here (see ARCHITECTURE.md) --
      // ServiceChannel's raw API responses are untyped JSON, and `any` is how
      // apiFetch()'s callers stay honest about that instead of pretending a
      // fake interface. Don't flag it; do keep everything else in `recommended`.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
