const { Essentia, EssentiaWASM } = require('essentia.js');
async function test() {
  const ess = new Essentia(EssentiaWASM);
  console.log(Object.keys(ess).filter(k => k[0] === k[0].toUpperCase() && typeof ess[k] === 'function'));
}
test();
