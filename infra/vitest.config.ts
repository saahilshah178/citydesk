import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Synthesizing the stack bundles two Lambda entries with esbuild through `pnpm exec`.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
