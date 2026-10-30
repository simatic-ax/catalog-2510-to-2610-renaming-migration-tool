export interface MigratedFile {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly content: string;
  readonly hasChanges: boolean;
  readonly reportWhenUnchanged?: boolean;
  readonly skipWhenPathSkipped?: string;
}