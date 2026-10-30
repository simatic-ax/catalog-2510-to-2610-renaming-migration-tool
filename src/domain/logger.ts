export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const nullLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export type LogLevel = "info" | "warning" | "error";

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
}

export class CapturingLogger implements Logger {
  readonly entries: LogEntry[] = [];

  info(message: string): void {
    this.entries.push({ level: "info", message });
  }

  warn(message: string): void {
    this.entries.push({ level: "warning", message });
  }

  error(message: string): void {
    this.entries.push({ level: "error", message });
  }

  get messages(): string[] {
    return this.entries.map((entry) => entry.message);
  }
}