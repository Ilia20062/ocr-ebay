import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // tesseract.js does its own worker/wasm path resolution at runtime using
  // __dirname / require.resolve. Bundling it through Next's webpack pipeline
  // breaks those lookups (results in path.resolve(undefined) → "filename
  // argument must be of type string or URL" errors). Loading it as an external
  // package keeps it on Node's CJS resolver where __dirname is defined.
  serverExternalPackages: ["tesseract.js", "tesseract.js-core"],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/sign/**',
      },
    ],
  },
};

export default nextConfig;
