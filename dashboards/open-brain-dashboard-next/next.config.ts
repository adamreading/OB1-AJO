import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the Turbopack workspace root to THIS directory. Without this, Next
  // walks up the tree looking for a package-lock.json and may pick the one
  // in C:\Users\JoannaThompson\ (a stray from an unrelated CLI install)
  // instead of the dashboard's own lockfile.
  turbopack: {
    root: path.resolve(__dirname),
  },

  // Origins permitted to POST Server Actions in dev. Without this, the login
  // form silently fails when the dashboard is accessed via any hostname other
  // than localhost (Tailscale, LAN IP, etc.) because Next 16 rejects the
  // action as cross-origin.
  allowedDevOrigins: [
    "192.168.0.140",                  // LAN IP (legacy)
    "ajo-ai",                         // Tailscale MagicDNS short name
    "100.117.68.26",                  // Tailscale IP
    "ajo-ai.tail9c43a2.ts.net",       // Tailscale MagicDNS FQDN (explicit)
    "*.tail9c43a2.ts.net",            // wildcard for any tailnet host
  ],
};

export default nextConfig;
