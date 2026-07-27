/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export — Netlify serves plain files; API is reached via netlify.toml
  // proxy redirects, so no server runtime is needed.
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
};

module.exports = nextConfig;
