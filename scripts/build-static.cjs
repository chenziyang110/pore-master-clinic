const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
const output = path.join(root, 'dist');
const art = ['manga-base', 'manga-dress-sky', 'manga-dress-peach', 'manga-dress-lilac', 'manga-hair-bob', 'manga-hair-twintails'];
const files = ['index.html', 'favicon.svg', ...art.map(name => 'assets/character/' + name + '.webp')];

const old = fs.lstatSync(output, { throwIfNoEntry: false });
if (old && (!old.isDirectory() || old.isSymbolicLink())) {
  throw new Error('Refusing to replace dist because it is not a regular directory.');
}
// Validate the complete asset set before replacing any previous build.
for (const file of files) {
  const source = path.join(root, file);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid static source: ' + file);
  const actual = fs.realpathSync(source);
  if (!actual.startsWith(root + path.sep)) throw new Error('Static source escapes project: ' + file);
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output);
for (const file of files) {
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
console.log('Built index.html, favicon.svg and ' + art.length + ' manga character assets.');
