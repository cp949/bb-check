export function label(value, fallback) {
  const prefix = "value:";
  return prefix + (value?.name || fallback);
}
