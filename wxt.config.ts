import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';

const ortDist = (file: string) => fileURLToPath(new URL(`./node_modules/onnxruntime-web/dist/${file}`, import.meta.url));
/** WebGPU runtime (asyncify build in ORT 1.23): JS glue + WebAssembly, loaded from /ort/ at runtime. */
const ORT_RUNTIME_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

export default defineConfig({
  // Visible folder (macOS hides dot-folders like .output in Finder / file pickers).
  outDir: 'dist',
  manifest: {
    name: 'Region Image Grabber',
    description: 'Drag a rectangle on any page to find, preview and download the images inside it.',
    permissions: ['activeTab', 'scripting', 'downloads', 'contextMenus', 'offscreen', 'storage'],
    optional_host_permissions: ['<all_urls>'],
    // ONNX Runtime compiles WebAssembly; MV3 only allows that with 'wasm-unsafe-eval'.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    action: {
      default_title: 'Select region to grab images (Alt+Shift+S)',
    },
    commands: {
      'start-selection': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Select region to grab images',
      },
    },
  },
  hooks: {
    // ONNX Runtime's glue + WebAssembly are served from the extension package (never a CDN).
    'build:publicAssets': (_wxt, files) => {
      for (const file of ORT_RUNTIME_FILES) files.push({ absoluteSrc: ortDist(file), relativeDest: `ort/${file}` });
    },
  },
  vite: () => ({
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
    resolve: {
      // Use the build that imports its runtime from `wasmPaths` instead of the all-in-one
      // bundle, whose self-referencing dynamic import breaks after Vite bundling.
      alias: { 'onnxruntime-web/webgpu': ortDist('ort.webgpu.min.mjs') },
    },
  }),
});
