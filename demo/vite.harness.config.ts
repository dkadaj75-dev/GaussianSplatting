import { defineConfig } from 'vite';

// Separate config so the harness build cannot disturb the published demo build.
export default defineConfig({
  build: {
    outDir: 'dist-harness',
    emptyOutDir: true,
    rollupOptions: {
      input: 'harness.html',
      output: { inlineDynamicImports: true, entryFileNames: 'harness.js' },
    },
  },
});
