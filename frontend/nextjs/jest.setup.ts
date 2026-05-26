/**
 * Global Jest setup. Loaded by jest.config.ts.
 *
 * Currently just pulls in @testing-library/jest-dom so component tests
 * have access to matchers like `toBeInTheDocument`, `toHaveTextContent`, etc.
 * Add global mocks here (fetch, observers) only when something hits them.
 */
import '@testing-library/jest-dom';
