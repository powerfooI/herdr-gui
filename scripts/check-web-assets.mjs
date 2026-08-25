import { readdir, stat } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const publicRoot = fileURLToPath(new URL("../server/public/", import.meta.url));
const maxFileCount = 160;
const maxTotalBytes = 12 * 1024 * 1024;

async function collectAssetStats(root) {
  const directories = [root];
  let fileCount = 0;
  let totalBytes = 0;

  while (directories.length) {
    const directory = directories.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      const metadata = await stat(path);
      fileCount += 1;
      totalBytes += metadata.size;
    }
  }

  return { fileCount, totalBytes };
}

const { fileCount, totalBytes } = await collectAssetStats(publicRoot);
const totalMiB = (totalBytes / 1024 / 1024).toFixed(1);
const message = `web asset budget: ${fileCount}/${maxFileCount} files, ${totalMiB}/${maxTotalBytes / 1024 / 1024} MiB`;

if (fileCount > maxFileCount || totalBytes > maxTotalBytes) {
  process.stderr.write(`${message.replace("budget:", "budget exceeded:")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${message}\n`);
}
