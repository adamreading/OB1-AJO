import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Origins permitted to POST Server Actions in dev. Without this, the login
  // form silently fails when the dashboard is accessed via any hostname other
  // than localhost (Tailscale, LAN IP, etc.) because Next 16 rejects the
  // action as cross-origin.
  allowedDevOrigins: [
    "192.168.0.140",   // LAN IP (legacy)
    "ajo-ai",          // Tailscale MagicDNS short name
    "100.117.68.26",   // Tailscale IP
    "*.ts.net",        // Tailscale MagicDNS FQDN wildcard
  ],
};

export default nextConfig;
