import type { NextConfig } from "next";

const stagingBuild = process.env.CHANGEGATE_STAGING_BUILD === "1";

const nextConfig: NextConfig = stagingBuild ? {
  output: "standalone",
  async redirects() {
    return [{ source: "/", destination: "/merchant", permanent: false }];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; form-action 'self'; base-uri 'self'" },
        { key: "Strict-Transport-Security", value: "max-age=86400" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    }];
  },
} : {};

export default nextConfig;
