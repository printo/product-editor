/**
 * Jest config for the Next.js 16 + React 19 frontend.
 *
 * Uses `next/jest` which auto-configures:
 *   - TS/TSX transforms via SWC (matches Next.js build)
 *   - path aliases from tsconfig (so `@/lib/calendar` resolves)
 *   - CSS modules / next/image / next/font mocks
 *
 * One config wins both component tests (jsdom env, RTL) and pure-function
 * tests (anything under `__tests__/`). PRD §5 Phase 5 Day-0 deliverable.
 */
import type { Config } from 'jest';
import nextJest from 'next/jest.js';

const createJestConfig = nextJest({
  // Next.js dir to load next.config.js and .env files from
  dir: './',
});

const config: Config = {
  // happy-dom is faster than jsdom and — critically — doesn't auto-require
  // the native `canvas` module (which Fabric.js peer-deps and which jsdom
  // tries to load on init). Component tests don't render pixels; they just
  // need a DOM. happy-dom fits exactly.
  testEnvironment: '@happy-dom/jest-environment',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  // Only pick up __tests__ files under src/ — keeps Jest off node_modules,
  // .next/, and the embed proxy route handlers (which have their own test
  // story when needed).
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.test.ts?(x)',
    '<rootDir>/src/**/*.test.ts?(x)',
  ],
  // Coverage off by default — opt in via `pnpm test -- --coverage`.
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // Stub the `canvas` native module — NOT exercised under the current
    // happy-dom testEnvironment, but kept as a fallback if anyone reverts
    // to jest-environment-jsdom. jsdom auto-requires `canvas` when it's
    // installed as a peer-dep (Fabric.js pulls it in), then crashes on
    // the missing `canvas.node` binary. happy-dom avoids this entirely.
    '^canvas$': '<rootDir>/__mocks__/canvas.ts',
    '^canvas/lib/bindings$': '<rootDir>/__mocks__/canvas.ts',
  },
};

export default createJestConfig(config);
