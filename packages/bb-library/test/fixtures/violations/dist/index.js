import "leaky-dep";

export function greet(person) {
  return person?.name ?? "guest";
}

export function makeId() {
  return structuredClone({ id: 1 });
}
