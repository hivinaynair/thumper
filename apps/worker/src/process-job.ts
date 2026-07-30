import { processJobById } from "./process-one";

const jobId = process.argv
  .find((a) => a.startsWith("--jobId="))
  ?.slice("--jobId=".length);

if (!jobId) {
  console.error("Usage: bun run process-job --jobId=<uuid>");
  process.exit(2);
}

processJobById(jobId)
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
