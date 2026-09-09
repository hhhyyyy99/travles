/** @type {import('next').NextConfig} */
const isGithubActions = process.env.GITHUB_ACTIONS || false;

const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  // GitHub Pages 部署路径通常为 https://<user>.github.io/<repo-name>/
  basePath: isGithubActions ? '/tibet-road-trip-guide' : '',
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
