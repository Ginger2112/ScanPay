import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The hosted checkout is embedded in merchant storefronts (Shopify Thank You
  // page, later WooCommerce). Those origins frame it, so we cannot send
  // X-Frame-Options: DENY globally. Framing is restricted per-merchant in
  // middleware instead.
  poweredByHeader: false,
};

export default nextConfig;
