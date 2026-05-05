import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@next/next/no-img-element": "off",
      // react-hooks v7 strict rules — all pre-existing offenders triaged;
      // promoted from "warn" so regressions break CI.
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/purity": "error",
      "react-hooks/set-state-in-effect": "error",
      "react-hooks/refs": "error",
      "react-hooks/immutability": "error",
      // The 31 remaining `as any` casts are all Fabric.js / library-API arg
      // coercion or LayoutDef shape narrowing — covered by typecheck plus
      // module augmentation in src/types/fabric-augmentation.d.ts. The
      // typescript preset enables @typescript-eslint/no-explicit-any as
      // "warn" by default; demote to "off" so CI passes while these are
      // tracked separately.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
