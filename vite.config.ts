import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";

// onnxruntime-web's default entry references its ~27 MB .wasm via
// new URL(..., import.meta.url), which Vite would copy/inline into every build.
// Use the non-bundled entry instead; src/upscaler.ts points it at the CDN copy.
const ortConfig = {
  resolve: {
    alias: [
      {
        find: /^onnxruntime-web\/webgpu$/,
        replacement: fileURLToPath(new URL("./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs", import.meta.url)),
      },
    ],
  },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
};

// Three build targets:
//   npm run build            -> standalone static site (dist/), relative base
//                               so it works on any host or subpath (GitHub Pages,
//                               Vercel, a nested folder, etc.)
//   npm run build:component  -> single self-contained ES module (dist-component/)
//                               that registers the <media-converter> element.
//   npm run build:pages      -> single self-contained index.html, inlined JS/CSS,
//                               written to dist-pages/ and deployed to GitHub Pages
//                               by .github/workflows/deploy-pages.yml.
export default defineConfig(({ mode }) => {
  const isComponent = mode === "component";
  const isPages = mode === "pages";

  if (isPages) {
    return {
      ...ortConfig,
      base: "./",
      plugins: [viteSingleFile()],
      build: {
        outDir: "dist-pages",
        emptyOutDir: true,
        assetsInlineLimit: Infinity,
        cssCodeSplit: false,
        chunkSizeWarningLimit: 10000,
      },
    };
  }

  return {
    ...ortConfig,
    base: "./",
    build: isComponent
      ? {
          outDir: "dist-component",
          cssCodeSplit: false,
          lib: {
            entry: "src/component.ts",
            name: "MediaConverter",
            formats: ["es"],
            fileName: () => "media-converter.js",
          },
        }
      : {
          outDir: "dist",
        },
  };
});
