# Catalog 2510 to 2610 Migration Tool

## Description

This command-line tool migrates SIMATIC AX catalog 2510 applications, libraries, and workspaces to catalog 2610.

## Scope

- Renames supported catalog 2510 packages and namespaces to their catalog 2610 equivalents.
- Updates `apax.yml` while preserving its comments, quoting, ordering, and line endings.
- Generates `make.yml` from the existing APAX build configuration.

## Not in Scope

- Deprecated `@ax/simatic-1500-*` packages from catalog 2504 are not supported.
- Catalogs older than 2510 are not supported.
- Scripts in `apax.yml` are not migrated.
- XLAD source files ending in `.ld` are not migrated.
- XLAD-generated files under `src/.gen` are not migrated.
- Only SIMATIC AX LCE projects are supported. UE and SIMATIC AX RT projects are not supported.
- Instruction-level migration is not supported. The tool does not update instruction names or parameters in source code.
- Extension breaking changes are not supported. The migration tool does not change any extension settings or keybindings.

## Prerequisites

- Node.js 20 or newer.
- Apax version 4.3.0 or newer.
- User logged in AX with `apax login`.
- Project dependencies, including this migration tool are installed with `apax install`.


## Installation

1. Add the registry to `apax.yml`, then log in with `apax login`:

```yaml
registries:
  "@simatic-ax": "https://npm.pkg.github.com/"
```

2. Install the package with the following command:

```powershell
apax add @simatic-ax/catalog-2510-to-2610-renaming-migration-tool --dev
```

## Command

```powershell
apax migratetocatalog2610 [options]
```

| Option                   | Description                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-o, --output <path>`  | Export destination. The default is`migrated_project` inside each migrated project.                                                                      |
| `-m, --mode <mode>`    | Migration mode:`Export` (default) or `OverWrite`. Values are case-insensitive.                                                                        |
| `-s, --skipsave`       | Do not create a backup ZIP in`OverWrite` mode. File-overwrite confirmations remain enabled.                                                             |
| `--accept-all-prompts` | Select all workspace projects and accept all export replacement and file-overwrite prompts.                                                               |
| `--catalog <catalog>`  | Target catalog:`latest`, a `2610.x.y` version, or a full reference such as `@domain/catalog@2610.0.0`. The default is `@ax-as/s7-catalog@latest`. |
| `--exact`              | Write the resolved catalog version without a compatibility prefix.                                                                                        |
| `--tilde`              | Write the resolved catalog version with`~`.                                                                                                             |
| `--caret`              | Write the resolved catalog version with`^`.                                                                                                             |

Only one of `--exact`, `--tilde`, and `--caret` can be used. If none is supplied, the target catalog inherits  catalog's  compatibility mode`^`, `~`, or exact from original `apax.yml`

## Dependency Version Resolution

The tool first creates an isolated manifest in the operating system's temporary directory and runs `apax add --catalog` once to fetch the selected catalog. For a workspace, this acquisition runs once for all selected children and uses registry and public-key settings from the first selected child.

The resolved catalog metadata supplies versions for catalog-managed packages. Mapped packages absent from the catalog are resolved with `apax list -p`. Dependency versions preserve their original `^`, `~`, or exact compatibility style.

If a package lookup fails, returns malformed output, or cannot start, the tool logs the failure, assigns the  version `latest`, and continues. If catalog acquisition or catalog-cache parsing fails, migration stops; original files remain unchanged, and no backup or migration output is created.

Before writing `apax.yml`, the tool removes its own package entry and duplicate keys created during renaming within the same dependency section. A package present in both `dependencies` and `devDependencies` is migrated and retained in both sections.

## Use Cases

### Export to a custom directory

```powershell
apax migratetocatalog2610 --output <path>
```

If `--output` is omitted, the tool creates a `migrated_project` directory inside the project. Replacing an existing export directory recreates all generated files, including `make.yml`.

### Select a catalog version and compatibility mode

Without `--catalog`, the tool uses `@ax-as/s7-catalog@latest`:

```powershell
apax migratetocatalog2610
```

Use `latest` explicitly:

```powershell
apax migratetocatalog2610 --catalog latest
```

Select a numeric version of the default catalog package:

```powershell
apax migratetocatalog2610 --catalog 2610.0.0 --exact
```

Select a full scoped catalog package reference and version:

```powershell
apax migratetocatalog2610 --catalog @ax-as/s7-catalog@2610.0.0 --exact
```

Without `--exact`, `--tilde`, or `--caret`, the target catalog uses the compatibility mode from the catalog entry in `apax.yml`.

### Migrate in place with a backup

```powershell
apax migratetocatalog2610 --mode OverWrite
```

commanBefore changing files, the tool creates a timestamped ZIP beside the project content. It then asks before overwriting each changed file. Choose `a` to approve all remaining changes, or use `-s`/`--skipsave` to disable ZIP creation.

### Migrate a workspace with multiple apps and libraries

To migrate an AX workspace, run the command from the workspace root containing `type: workspace`. The tool lists valid direct child apps and libraries. Enter comma-separated project numbers to select projects, or enter `a` to migrate all; a single valid child is selected automatically. Running the command from an app or library migrates only that project, even when it is located inside a workspace.

The catalog is acquired once before any child migration starts. If acquisition fails, the entire workspace migration stops without writing child output or backups.

```powershell
apax migratetocatalog2610 --mode OverWrite
```
