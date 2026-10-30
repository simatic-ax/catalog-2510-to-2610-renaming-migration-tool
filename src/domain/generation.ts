export enum GenerationMode {
  Export = "export",
  Overwrite = "overwrite",
}

export interface GenerationTarget {
  readonly outputDirectory: string;
  readonly replaceOutputDirectory?: boolean;
}