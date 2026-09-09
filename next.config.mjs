/** @type {import('next').NextConfig} */
const isExport = process.env.NEXT_EXPORT === 'true' || process.env.GITHUB_ACTIONS === 'true';
const isGithubActions = process.env.GITHUB_ACTIONS || false;

const nextConfig = {
  reactStrictMode: true,
  // 当指定导出或处于 GitHub Actions 时启用纯静态导出
  ...(isExport ? { output: 'export' } : {}),
  basePath: isGithubActions ? '/tibet-road-trip-guide' : '',
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
