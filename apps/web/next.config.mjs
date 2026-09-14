/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@thumper/shared", "@thumper/db", "@thumper/pipeline"],
  serverExternalPackages: [
    "pg-boss",
    "postgres",
    "pino",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "@aws-sdk/lib-storage",
  ],
};

export default nextConfig;
