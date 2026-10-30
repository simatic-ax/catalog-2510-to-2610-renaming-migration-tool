export function findKey<T>(mapping: Readonly<Record<string, T>>, key: string): string | undefined {
  const normalizedKey = key.toLocaleLowerCase("en-US");
  return Object.keys(mapping).find(
    (candidate) => candidate.toLocaleLowerCase("en-US") === normalizedKey,
  );
}

export function getValue<T>(
  mapping: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  const existingKey = findKey(mapping, key);
  return existingKey === undefined ? undefined : mapping[existingKey];
}

export function deleteKey<T>(mapping: Record<string, T>, key: string): boolean {
  const existingKey = findKey(mapping, key);
  return existingKey === undefined ? false : delete mapping[existingKey];
}

export function buildCaseInsensitiveMap<T>(
  entries: readonly T[],
  keySelector: (entry: T) => string,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const entry of entries) {
    const key = keySelector(entry);
    const existingKey = findKey(result, key);
    if (existingKey !== undefined) {
      if (JSON.stringify(result[existingKey]) !== JSON.stringify(entry)) {
        throw new Error(`Conflicting migration mapping for '${key}'.`);
      }
      continue;
    }
    result[key] = entry;
  }
  return result;
}