import "declared-leaky-dep";
import "optional-leaky-dep";
import "totally-missing-dep";

const chunkName = pickChunkName();

export function loadDynamicByVariable() {
  return import(chunkName);
}

export function loadDynamicByTemplate(id) {
  return import(`./chunks/${id}.js`);
}

export function loadWithRequire() {
  return require(chunkName);
}
