// Publish only browser assets and explicitly selected sample images.
// Each build gets a new directory; no workspace or previous build is deleted.
import { copyFile, mkdir, mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_IMAGES } from '../web/state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserFiles = [
  'index.html', 'styles.css', 'app.js', 'state.js', 'image-source.js',
  'renderer.js', 'shaders.js', 'input.js', 'audio.js',
];
await mkdir(path.join(root, 'dist'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'dist', 'site-'));
const files = [];
let bytes = 0;

async function copyAsset(input, output) {
  const actual = await realpath(path.join(root, input));
  if (!actual.startsWith(`${root}${path.sep}`)) throw new Error(`Asset leaves workspace: ${input}`);
  const details = await stat(actual);
  if (!details.isFile()) throw new Error(`Asset is not a file: ${input}`);
  const destination = path.join(directory, output);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(actual, destination);
  files.push(output);
  bytes += details.size;
}

for (const name of browserFiles) await copyAsset(`web/${name}`, name);
for (const sample of SAMPLE_IMAGES) {
  if (sample.url === 'demo') continue;
  if (!sample.url.startsWith('./images/')) throw new Error(`Expected a relative image asset: ${sample.url}`);
  const relative = decodeURIComponent(sample.url.slice(2));
  if (relative.split('/').some(part => part.startsWith('.') || part.includes('\\'))) {
    throw new Error(`Invalid asset path: ${relative}`);
  }
  await copyAsset(relative, relative);
}
// Disable Jekyll processing when publishing the static bundle on GitHub Pages.
await writeFile(path.join(directory, '.nojekyll'), '');
files.push('.nojekyll');
console.log(JSON.stringify({ directory, files, bytes }, null, 2));
