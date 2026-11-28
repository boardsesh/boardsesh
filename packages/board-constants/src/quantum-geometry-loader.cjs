// Keep the require inside the function: importing another board's constants
// must not evaluate the Quantum geometry. CommonJS supplies a module-local
// require in bare Node ESM too, without import.meta or a Node-only builtin in
// code that Playwright and Metro compile to CommonJS.
module.exports = function loadQuantumGeometryTables() {
  return require('./generated/quantum-geometry.cjs');
};
