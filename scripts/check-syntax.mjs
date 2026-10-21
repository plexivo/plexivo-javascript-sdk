import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Throw on the first invalid file; a directory traversal must not hide a
// child process's nonzero exit status.
export function checkSyntax(directories) {
  let checked = 0;
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
        execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
        checked++;
      }
    }
  }
  for (const directory of directories) walk(directory);
  if (checked === 0) throw new Error('No JavaScript source files were checked');
  return checked;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const checked = checkSyntax(['src', 'scripts', 'test'].map(dir => join(root, dir)));
  console.log(`Syntax checked ${checked} JavaScript files`);
}
