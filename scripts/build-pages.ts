import { cp, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(root, "site");
const outputDirectory = join(root, ".pages-dist");
const assetDirectory = join(outputDirectory, "assets");

const assets = [
  [
    "docs/images/herdr-studio-desktop-session-history.png",
    "herdr-studio-desktop-session-history.png",
  ],
  [
    "docs/images/herdr-studio-desktop-file-explorer.png",
    "herdr-studio-desktop-file-explorer.png",
  ],
  [
    "docs/images/herdr-studio-desktop-diff-viewer.png",
    "herdr-studio-desktop-diff-viewer.png",
  ],
  [
    "docs/images/herdr-studio-desktop-terminal.png",
    "herdr-studio-desktop-terminal.png",
  ],
  [
    "docs/images/herdr-studio-mobile-changed-files.png",
    "herdr-studio-mobile-changed-files.png",
  ],
  [
    "docs/images/herdr-studio-mobile-file-viewer.png",
    "herdr-studio-mobile-file-viewer.png",
  ],
  [
    "docs/images/herdr-studio-mobile-terminal.png",
    "herdr-studio-mobile-terminal.png",
  ],
] as const;

async function ensureFile(path: string): Promise<void> {
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`Expected a file at ${path}`);
}

async function verifyLocalReferences(): Promise<void> {
  const htmlPath = join(outputDirectory, "index.html");
  const html = await Bun.file(htmlPath).text();
  const directReferences = [
    ...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g),
  ].map((match) => match[1].split(/[?#]/, 1)[0]);
  const sourceSetReferences = [...html.matchAll(/srcset="([^"]+)"/gs)]
    .map((match) => match[1])
    .join(",")
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
    .filter(Boolean);
  const references = [...directReferences, ...sourceSetReferences];

  for (const reference of new Set(references)) {
    await ensureFile(join(outputDirectory, reference));
  }

  if (html.includes('href="/') || html.includes('src="/')) {
    throw new Error(
      "Root-relative site assets break on the GitHub Pages subpath",
    );
  }
}

await rm(outputDirectory, { force: true, recursive: true });
await cp(sourceDirectory, outputDirectory, { recursive: true });
await mkdir(assetDirectory, { recursive: true });

for (const [source, destination] of assets) {
  const sourcePath = join(root, source);
  await ensureFile(sourcePath);
  await copyFile(sourcePath, join(assetDirectory, destination));
}

const build = await Bun.build({
  entrypoints: [
    join(sourceDirectory, "main.js"),
    join(sourceDirectory, "styles.css"),
  ],
  outdir: outputDirectory,
  minify: true,
  target: "browser",
});
if (!build.success) {
  throw new AggregateError(build.logs, "Failed to optimize the landing page");
}

await writeFile(join(outputDirectory, ".nojekyll"), "");
await verifyLocalReferences();

const size = await Array.fromAsync(
  new Bun.Glob("**/*").scan({ cwd: outputDirectory, onlyFiles: true }),
  async (path) => {
    const file = await stat(join(outputDirectory, path));
    return file.size;
  },
).then((sizes) => sizes.reduce((total, fileSize) => total + fileSize, 0));

process.stdout.write(
  `Built GitHub Pages site in .pages-dist (${assets.length} shared screenshots, ${(size / 1024 / 1024).toFixed(2)} MiB)\n`,
);
