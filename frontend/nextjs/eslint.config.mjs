import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

// Flat config replacing legacy .eslintrc.json. The eslint-config-next/typescript
// preset is intentionally NOT included — it forbids `any`, but the codebase
// still has ~200 `as any` casts (mostly Fabric.js custom properties) that
// haven't been typed yet. tsconfig.json keeps `noImplicitAny: false` for the
// same reason. Re-enable the typescript preset once those casts are typed.
export default [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      "@next/next/no-img-element": "off",
      // The react-hooks plugin v7 (pulled in by eslint-config-next 16) ships
      // several new strict rules. All 18 pre-existing offenders have been
      // triaged: real bugs fixed (refs-in-render, set-state-in-effect,
      // variable-before-declared, Date.now during render); intentional
      // dep-array exclusions kept with per-line eslint-disable + a comment
      // explaining why. Promoted to "error" so the next regression breaks CI.
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/purity": "error",
      "react-hooks/set-state-in-effect": "error",
      "react-hooks/refs": "error",
      "react-hooks/immutability": "error",
    },
  },
];
