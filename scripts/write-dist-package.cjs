const { readFileSync, writeFileSync } = require("node:fs");

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

writeFileSync("dist/package.json", `${JSON.stringify({ type: "module", version })}\n`, "utf8");