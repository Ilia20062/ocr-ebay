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
  // Force-include Tesseract worker/core assets in the standalone trace.
  // Next's nft tracer can miss them because they're resolved by string at
  // runtime, not statically imported.
  outputFileTracingIncludes: {
    "/**/*": [
      "./node_modules/tesseract.js/src/worker-script/node/**",
      "./node_modules/tesseract.js-core/**",
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
