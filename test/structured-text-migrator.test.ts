import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateStructuredText } from "../src/migration/structured-text-migrator.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migrateStructuredText", () => {
  it("migrates code while preserving protected content and excluding generated source files", () => {
    const project = createTemporaryDirectory();
    const sourceContent = [
      "/* USING Siemens.Simatic.Communication.IPConfiguration; */",
      "using Siemens.Simatic.Communication.IPConfiguration;",
      "USING Siemens.Simatic.Communication.IPConfiguration",
      "PROGRAM Main",
      "    Siemens.Simatic.Communication.IPConfiguration.Configure();",
      "    // Siemens.Simatic.Communication.IPConfiguration.Configure();",
      "    message := 'Siemens.Simatic.Communication.IPConfiguration.Configure';",
      "    /* Siemens.Simatic.Communication.IPConfiguration.Configure(); */",
      "END_PROGRAM",
    ].join("\n");
    const sourcePath = writeProjectFile(project, "src/Main.st", sourceContent);
    writeProjectFile(
      project,
      "src/.gen/Generated.st",
      "Siemens.Simatic.Communication.IPConfiguration.Configure();",
    );

    const migratedFiles = migrateStructuredText(join(project, "src"), join(project, "output"));

    expect(migratedFiles).toHaveLength(1);
    expect(migratedFiles[0]).toEqual({
      sourcePath,
      outputPath: join(project, "output", "src", "Main.st"),
      content: sourceContent
        .replace(
          "using Siemens.Simatic.Communication.IPConfiguration;",
          "USING Siemens.S7.Communication.IPConfiguration;",
        )
        .replace(
          "    Siemens.Simatic.Communication.IPConfiguration.Configure();",
          "    Siemens.S7.Communication.IPConfiguration.Configure();",
        ),
      hasChanges: true,
    });
  });

  it("matches fully qualified namespaces case-insensitively and longest-first", () => {
    const project = createTemporaryDirectory();
    writeProjectFile(
      project,
      "test/nested/Case.st",
      [
        "uSiNg SIEMENS.SIMATIC.TASKS ; // keep tail",
        "siemens.simatic.communication.ipconfiguration.Configure();",
        'message := "Siemens.Simatic.Communication.IPConfiguration.Configure";',
        "prefixSiemens.Simatic.Tasks.Run();",
      ].join("\n"),
    );

    const [migrated] = migrateStructuredText(join(project, "test"), join(project, "output"));

    expect(migrated?.outputPath).toBe(join(project, "output", "test", "nested", "Case.st"));
    expect(migrated?.content).toBe(
      [
        "USING Siemens.S7.Tasks ; // keep tail",
        "Siemens.S7.Communication.IPConfiguration.Configure();",
        'message := "Siemens.Simatic.Communication.IPConfiguration.Configure";',
        "prefixSiemens.Simatic.Tasks.Run();",
      ].join("\n"),
    );
  });

  it("migrates the approved motion-control namespaces longest-first", () => {
    const project = createTemporaryDirectory();
    writeProjectFile(
      project,
      "src/Motion.st",
      [
        "Siemens.Simatic.MotionControl.Native.Run();",
        "Siemens.Simatic.MotionControl.Run();",
      ].join("\n"),
    );

    const [migrated] = migrateStructuredText(join(project, "src"), join(project, "output"));

    expect(migrated?.content).toBe([
      "Siemens.S7.MotionControl.Run();",
      "Siemens.S7.LAxisCtrl.Oop.Run();",
    ].join("\n"));
  });

  it("excludes only the root .gen directory when the source root is src", () => {
    const project = createTemporaryDirectory();
    writeProjectFile(project, "src/.gen/Excluded.st", "Siemens.Simatic.Tasks.Run();");
    writeProjectFile(project, "src/nested/.gen/Included.st", "Siemens.Simatic.Tasks.Run();");

    const migratedFiles = migrateStructuredText(join(project, "src"), join(project, "output"));

    expect(migratedFiles).toHaveLength(1);
    expect(migratedFiles[0]?.outputPath).toBe(
      join(project, "output", "src", "nested", ".gen", "Included.st"),
    );
    expect(migratedFiles[0]?.content).toBe("Siemens.S7.Tasks.Run();");
  });

  it("excludes .apax directories at any depth case-insensitively", () => {
    const project = createTemporaryDirectory();
    writeProjectFile(project, "src/.apax/Excluded.st", "Siemens.Simatic.Tasks.Run();");
    writeProjectFile(project, "src/nested/.APAX/Excluded.st", "Siemens.Simatic.Tasks.Run();");
    writeProjectFile(project, "src/nested/Included.st", "Siemens.Simatic.Tasks.Run();");

    const migratedFiles = migrateStructuredText(join(project, "src"), join(project, "output"));

    expect(migratedFiles).toHaveLength(1);
    expect(migratedFiles[0]?.outputPath).toBe(
      join(project, "output", "src", "nested", "Included.st"),
    );
  });
});

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "structured-text-migrator-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeProjectFile(project: string, relativePath: string, content: string): string {
  const filePath = join(project, ...relativePath.split("/"));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  return filePath;
}