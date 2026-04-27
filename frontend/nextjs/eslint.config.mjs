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
      // several new strict rules that surface real-but-noncritical patterns
      // throughout the editor. Demoted to warnings so lint passes; promote each
      // to "error" once existing offenders have been triaged per-case.
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
];
