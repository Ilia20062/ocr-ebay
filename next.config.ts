import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Standalone build is required for the Electron desktop packaging.
  // It produces .next/standalone/server.js with a self-contained node_modules
  // tree that electron-builder ships as an extraResource.
  output: "standalone",
  // Pin Turbopack workspace root to this project directory. Without this Next
  // detects a stray package-lock.json one level up and nests the standalone
  // build under .next/standalone/ocr-crm/, which breaks our packaging paths.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // tesseract.js does its own worker/wasm path resolution at runtime using
  // __dirname / require.resolve. Bundling it through Next's webpack pipeline
  // breaks those lookups (results in path.resolve(undefined) → "filename
  // argument must be of type string or URL" errors). Loading it as an external
  // package keeps it on Node's CJS resolver where __dirname is defined.
  serverExternalPackages: ["tesseract.js", "tesseract.js-core"],
  // Force-include the FULL Tesseract worker + core packages in the standalone
  // trace. Next's nft tracer can't follow the worker thread's runtime requires
  // (it's loaded by string path via node:worker_threads, not statically
  // imported). The worker entry `src/worker-script/node/index.js` does
  // `require('..')` → `src/worker-script/index.js` and pulls in the package's
  // own bundled node_modules; tracing only `worker-script/node/**` left those
  // out, so the worker thread died with MODULE_NOT_FOUND and createWorker()
  // hung forever. Include the whole packages so every runtime require resolves.
  outputFileTracingIncludes: {
    "/**/*": [
      "./node_modules/tesseract.js/**",
      "./node_modules/tesseract.js-core/**",
      // tesseract.js's runtime deps are npm-hoisted to the top-level
      // node_modules, so the worker thread's `require('bmp-js')` etc. miss the
      // trace. These are all zero-dependency leaf packages — listing them is a
      // complete closure for the Node worker path (setImage→bmp-js,
      // gunzip→zlibjs, loadLang→is-url+node-fetch, getCore→wasm-feature-detect).
      "./node_modules/bmp-js/**",
      "./node_modules/zlibjs/**",
      "./node_modules/is-url/**",
      "./node_modules/node-fetch/**",
      "./node_modules/wasm-feature-detect/**",
      "./node_modules/idb-keyval/**",
      "./node_modules/regenerator-runtime/**",
    ],
  },
  images: {
    remotePatterns: [
      // S3 presigned GET URLs (virtual-hosted and path-style, any region).
      {
        protocol: 'https',
        hostname: '**.amazonaws.com',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
