export type StringMapping = Record<string, string>;

export interface ApaxValues {
  sdkVersion: string;
  projectType: string;
  binFolder: string;
  catalogs: StringMapping;
  dependencies: StringMapping;
  devDependencies: StringMapping;
  registries: StringMapping;
  publicKeys: StringMapping;
  targets: string[];
  buildArgs: string[];
}

export interface ApaxSnapshot {
  readonly sdkVersion: string;
  readonly projectType: string;
  readonly binFolder: string;
  readonly catalogs: Readonly<StringMapping>;
  readonly dependencies: Readonly<StringMapping>;
  readonly devDependencies: Readonly<StringMapping>;
  readonly registries: Readonly<StringMapping>;
  readonly publicKeys: Readonly<StringMapping>;
  readonly targets: readonly string[];
  readonly buildArgs: readonly string[];
}

export interface ApaxConfig {
  readonly sourcePath: string;
  readonly originalContent: string;
  readonly original: ApaxSnapshot;
  readonly migrated: ApaxValues;
}

export function createApaxValues(values: Partial<ApaxValues> = {}): ApaxValues {
  return {
    sdkVersion: "",
    projectType: "",
    binFolder: "",
    catalogs: {},
    dependencies: {},
    devDependencies: {},
    registries: {},
    publicKeys: {},
    targets: [],
    buildArgs: [],
    ...values,
  };
}

export function createApaxConfig(
  values: Partial<ApaxValues> = {},
  sourcePath = "apax.yml",
  originalContent = "",
): ApaxConfig {
  const originalValues = cloneValues(createApaxValues(values));
  return {
    sourcePath,
    originalContent,
    original: freezeSnapshot(originalValues),
    migrated: cloneValues(originalValues),
  };
}

function cloneValues(values: ApaxValues): ApaxValues {
  return {
    ...values,
    catalogs: { ...values.catalogs },
    dependencies: { ...values.dependencies },
    devDependencies: { ...values.devDependencies },
    registries: { ...values.registries },
    publicKeys: { ...values.publicKeys },
    targets: [...values.targets],
    buildArgs: [...values.buildArgs],
  };
}

function freezeSnapshot(values: ApaxValues): ApaxSnapshot {
  return Object.freeze({
    ...values,
    catalogs: Object.freeze({ ...values.catalogs }),
    dependencies: Object.freeze({ ...values.dependencies }),
    devDependencies: Object.freeze({ ...values.devDependencies }),
    registries: Object.freeze({ ...values.registries }),
    publicKeys: Object.freeze({ ...values.publicKeys }),
    targets: Object.freeze([...values.targets]),
    buildArgs: Object.freeze([...values.buildArgs]),
  });
}