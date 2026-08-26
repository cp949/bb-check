export const normalizeSignalText = (value: unknown): string => {
  if (typeof value !== "string")
    throw new TypeError("signal text must be a string");
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized === "") throw new TypeError("signal text must not be empty");
  return normalized;
};
