/** @type {import('next').NextConfig} */
const path = require('path')

const nextConfig = {
  // Static export: produces a self-contained `out/` of HTML/JS/CSS that the
  // Aiden workbench bridge serves directly (single origin, alongside /api/*).
  // No Node server for the dashboard — `aiden web` serves the files.
  output: 'export',

  // No image optimization server in a static export.
  images: { unoptimized: true },

  // Pin tracing root to this directory (harmless for export; kept for parity).
  outputFileTracingRoot: path.join(__dirname),
}

module.exports = nextConfig
