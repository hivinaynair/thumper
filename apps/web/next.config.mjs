/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@thumper/shared", "@thumper/db", "@thumper/pipeline"],
  serverExternalPackages: ["pg-boss", "postgres", "pino"],
};

export default nextConfig;
