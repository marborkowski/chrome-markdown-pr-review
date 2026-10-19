import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only this checkout's tests: not the worktrees the Claude desktop app keeps under .claude/, nor built output.
    exclude: [...configDefaults.exclude, '.claude/**', 'dev/out/**', 'dist/**'],
  },
});
