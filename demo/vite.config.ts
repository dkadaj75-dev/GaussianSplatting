import { defineConfig } from 'vite';

// Everything must end up in one file: a published artifact is a single HTML
// document with no external requests allowed.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'bundle.js',
      },
    },
  },
});
