import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: false,
  transpilePackages: ['recharts', 'react-smooth'],
};

export default nextConfig;