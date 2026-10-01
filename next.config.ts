import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@babel/polyfill",
    "@babel/runtime-corejs2",
    "@webex/plugin-authorization",
    "@webex/plugin-encryption",
  ],
};

export default nextConfig;
