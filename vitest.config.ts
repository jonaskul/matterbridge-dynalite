import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Matterbridge is linked in (npm link matterbridge), not installed: its test
  // harness is run through Vitest so that it shares this project's Vitest.
  resolve: { dedupe: ['vitest'], preserveSymlinks: false },
  test: {
    include: ['test/**/*.test.ts'],
    globals: true, // Matterbridge's harness uses expect() without importing it
    setupFiles: ['test/no-ipv6-shim.ts'],
    testTimeout: 10_000,
    server: { deps: { inline: [/@matterbridge\/test-utils/, /matterbridge\/dist\/test-utils/] } },
  },
});
