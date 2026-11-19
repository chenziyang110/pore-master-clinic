const fs = require('node:fs');
const path = require('node:path');

const projectRoot = fs.realpathSync(path.resolve(__dirname, '..'));
const outputDirectory = path.join(projectRoot, 'dist');
const publicFiles = ['index.html', 'favicon.svg'];

// Resolve from this script, not the caller's working directory. Never follow
// an output symlink when clearing files from an earlier static build.
if (path.dirname(outputDirectory) !== projectRoot || path.basename(outputDirectory) !== 'dist') {
  throw new Error('The static output must be the project dist directory.');
}
const previousOutput = fs.lstatSync(outputDirectory, { throwIfNoEntry: false });
if (previousOutput && (!previousOutput.isDirectory() || previousOutput.isSymbolicLink())) {
  throw new Error('Refusing to replace dist because it is not a regular directory.');
}
for (const file of publicFiles) {
  if (!fs.statSync(path.join(projectRoot, file)).isFile()) {
    throw new Error(`Missing static source: ${file}`);
  }
}

fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory);
for (const file of publicFiles) {
  fs.copyFileSync(path.join(projectRoot, file), path.join(outputDirectory, file));
}
console.log(`Built ${publicFiles.map(file => `dist/${file}`).join(', ')}`);
