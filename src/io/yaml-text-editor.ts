const topLevelKeyPattern = /^[^\s#][^:]*:\s*/;

interface SectionRange {
  readonly start: number;
  readonly end: number;
}

export class YamlTextEditor {
  private currentContent: string;

  public constructor(content: string) {
    this.currentContent = content;
  }

  public get content(): string {
    return this.currentContent;
  }

  public updateMapping(
    sectionName: string,
    desired: Readonly<Record<string, string>>,
    renameMap: Readonly<Record<string, string>>,
  ): void {
    const desiredEntries = Object.entries(desired);
    const desiredMap = new Map(
      desiredEntries.map(([key, value]) => [key.toLowerCase(), { key, value }] as const),
    );
    const lines = this.splitLines(this.currentContent);
    const entryPattern = /^(?<indent>\s+)(?<key>"[^"]+"|'[^']+'|[^:#\s]+)\s*:\s*(?<value>[^#]*?)(?<comment>\s+#.*)?$/;
    const inlineEmptyPattern = new RegExp(
      `^(?<section>${escapeRegExp(sectionName)})\\s*:\\s*\\{\\s*\\}\\s*(?<comment>#.*)?$`,
      "i",
    );
    const inlineEmptyIndex = lines.findIndex((line) => inlineEmptyPattern.test(line));
    if (inlineEmptyIndex >= 0) {
      if (desiredEntries.length === 0) {
        return;
      }

      const groups = inlineEmptyPattern.exec(lines[inlineEmptyIndex] ?? "")?.groups;
      const existingSectionName = groups?.section ?? sectionName;
      const comment = groups?.comment;
      lines[inlineEmptyIndex] = `${existingSectionName}:${comment === undefined ? "" : ` ${comment}`}`;
    }
    const section = findSection(lines, sectionName);

    if (section === undefined) {
      const lastLine = lines.at(-1);
      if (lines.length > 0 && lastLine !== undefined && lastLine.trim().length > 0) {
        lines.push("");
      }

      lines.push(`${sectionName}:`);
      for (const [key, value] of desiredEntries) {
        lines.push(`  "${key}": ${value}`);
      }

      this.currentContent = this.joinLines(lines);
      return;
    }

    const bodyStart = section.start + 1;
    const body = lines.slice(bodyStart, section.end);
    const updatedBody: string[] = [];
    const handled = new Set<string>();
    let entryIndent = "  ";

    for (const line of body) {
      const match = entryPattern.exec(line);
      const groups = match?.groups;
      if (
        groups === undefined ||
        groups.indent === undefined ||
        groups.key === undefined ||
        groups.value === undefined
      ) {
        updatedBody.push(line);
        continue;
      }

      entryIndent = groups.indent;
      const existingKey = unquote(groups.key);
      const target = resolveTarget(existingKey, desiredMap, renameMap);
      if (target === undefined) {
        continue;
      }

      const normalizedTarget = target.key.toLowerCase();
      if (handled.has(normalizedTarget)) {
        continue;
      }

      updatedBody.push(
        `${entryIndent}${quoteLike(groups.key, target.key)}: ${quoteLike(groups.value.trim(), target.value)}${groups.comment ?? ""}`,
      );
      handled.add(normalizedTarget);
    }

    for (const [key, value] of desiredEntries) {
      if (!handled.has(key.toLowerCase())) {
        updatedBody.push(`${entryIndent}"${key}": ${value}`);
      }
    }

    lines.splice(bodyStart, section.end - bodyStart, ...updatedBody);
    this.currentContent = this.joinLines(lines);
  }

  public removeSection(sectionName: string): void {
    const lines = this.splitLines(this.currentContent);
    const section = findSection(lines, sectionName)
      ?? findInlineSection(lines, sectionName);
    if (section === undefined) {
      return;
    }

    let removeStart = section.start;
    while (removeStart > 0 && lines[removeStart - 1]?.trimStart().startsWith("#")) {
      removeStart--;
    }

    let removeEnd = section.end;
    while (
      removeEnd > section.start + 1 &&
      (lines[removeEnd - 1]?.trim().length === 0 ||
        lines[removeEnd - 1]?.trimStart().startsWith("#"))
    ) {
      removeEnd--;
    }

    lines.splice(removeStart, removeEnd - removeStart);
    this.currentContent = this.joinLines(lines);
  }

  public removeMappingEntries(mappingName: string, ...entryNames: string[]): void {
    const lines = this.splitLines(this.currentContent);
    const section = findSection(lines, mappingName);
    if (section === undefined) {
      return;
    }

    const mappingStart = section.start;
    let mappingEnd = section.end;
    const entryNamesSet = new Set(entryNames.map((name) => name.toLowerCase()));
    const entryPattern = /^(?<indent>\s+)(?<name>[^:#\s]+)\s*:/;

    for (let index = mappingEnd - 1; index > mappingStart; index--) {
      const match = entryPattern.exec(lines[index] ?? "");
      const indent = match?.groups?.indent;
      const name = match?.groups?.name;
      if (indent === undefined || name === undefined || !entryNamesSet.has(name.toLowerCase())) {
        continue;
      }

      const entryIndent = indent.length;
      let removeEnd = index + 1;
      while (removeEnd < mappingEnd) {
        const nextMatch = entryPattern.exec(lines[removeEnd] ?? "");
        const nextIndent = nextMatch?.groups?.indent;
        if (nextIndent !== undefined && nextIndent.length <= entryIndent) {
          break;
        }
        removeEnd++;
      }

      while (
        removeEnd > index + 1 &&
        (lines[removeEnd - 1]?.trim().length === 0 ||
          lines[removeEnd - 1]?.trimStart().startsWith("#"))
      ) {
        removeEnd--;
      }

      const removedCount = removeEnd - index;
      lines.splice(index, removedCount);
      mappingEnd -= removedCount;
    }

    this.currentContent = this.joinLines(lines);
    const hasRemainingEntries = lines
      .slice(mappingStart + 1, mappingEnd)
      .some((line) => entryPattern.test(line));
    if (!hasRemainingEntries) {
      this.removeSection(mappingName);
    }
  }

  private splitLines(yaml: string): string[] {
    return yaml.split(/\r\n|\n/);
  }

  private joinLines(lines: readonly string[]): string {
    return lines.join(this.newline);
  }

  private get newline(): string {
    return this.currentContent.includes("\r\n") ? "\r\n" : "\n";
  }
}

function findInlineSection(
  lines: readonly string[],
  sectionName: string,
): SectionRange | undefined {
  const sectionPattern = new RegExp(`^${escapeRegExp(sectionName)}\s*:`, "i");
  const start = lines.findIndex((line) => sectionPattern.test(line));
  return start < 0 ? undefined : { start, end: start + 1 };
}

function resolveTarget(
  existingKey: string,
  desired: ReadonlyMap<string, { readonly key: string; readonly value: string }>,
  renameMap: Readonly<Record<string, string>>,
): { readonly key: string; readonly value: string } | undefined {
  const existingTarget = desired.get(existingKey.toLowerCase());
  if (existingTarget !== undefined) {
    return existingTarget;
  }

  const renameKey = Object.keys(renameMap).find((key) =>
    key.toLocaleLowerCase("en-US") === existingKey.toLocaleLowerCase("en-US")
  );
  const renamedKey = renameKey === undefined ? undefined : renameMap[renameKey];
  return renamedKey === undefined ? undefined : desired.get(renamedKey.toLowerCase());
}

function findSection(lines: readonly string[], sectionName: string): SectionRange | undefined {
  const sectionPattern = new RegExp(`^${escapeRegExp(sectionName)}\\s*:\\s*(?:#.*)?$`, "i");
  const start = lines.findIndex((line) => sectionPattern.test(line));
  if (start < 0) {
    return undefined;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (topLevelKeyPattern.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }

  return { start, end };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquote(token: string): string {
  if (token.length < 2) {
    return token;
  }

  const first = token[0];
  const last = token[token.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? token.slice(1, -1)
    : token;
}

function quoteLike(originalToken: string, value: string): string {
  if (originalToken.startsWith('"') && originalToken.endsWith('"')) {
    return `"${value}"`;
  }

  return originalToken.startsWith("'") && originalToken.endsWith("'")
    ? `'${value}'`
    : value;
}