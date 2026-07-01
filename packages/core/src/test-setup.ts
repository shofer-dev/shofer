// Installs String.prototype.toPosix() for the package test environment, mirroring
// what src/vitest.setup.ts does for the extension: the augmentation lives in the
// path module and is applied as an import side effect.
import "./path/path.js"
