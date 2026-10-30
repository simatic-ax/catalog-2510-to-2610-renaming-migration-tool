export interface ConsoleIO {
  readLine(): Promise<string | undefined>;
  writeError(message: string): void;
  close?(): void;
}