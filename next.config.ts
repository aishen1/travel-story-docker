import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  // Docker 部署用：构建产出 standalone 最小运行包，减小镜像体积
  output: "standalone",
};

export default nextConfig;
