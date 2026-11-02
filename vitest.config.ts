import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Placeholders so modules that parse src/config/env.ts at import can load without a real database (nothing connects until a query runs).
  // Set explicitly so dotenv never pulls the dev DATABASE_URL from .env into a test run.
  test: {
    // dist holds compiled copies of the tests; they must not run (their mocks and aliases do not apply there).
    exclude: [...configDefaults.exclude, 'dist/**'],
    env: { DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test', JWT_SECRET: 'test-secret-test-secret-test-secret-0123' },
  },
});
