/** RFC 7396 JSON Merge Patch. */
export function applyJsonMergePatch<T>(target: T, patch: any): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }
  const result: any =
    target !== null && typeof target === "object" && !Array.isArray(target)
      ? { ...target }
      : {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = applyJsonMergePatch(result[key], value);
    }
  }
  return result as T;
}
