// Direct repro of the tsgo ("@typescript/typescript-linux-x64/lib/tsc") stderr noise.
// Mirrors scripts/ts-ast.mjs parseTexts: create API (spawns tsgo --api), then api.close() (kills it).
import { API } from "typescript/unstable/sync";
import { resolve } from "node:path";

const CONFIG_PATH = resolve(process.cwd(), ".ts-ast-virtual-project-repro.json");

function once() {
  const virtual = new Map();
  const f = resolve(process.cwd(), "src/index.ts");
  virtual.set(f, "import { x } from './params';\n");
  const config = JSON.stringify({ compilerOptions: { noResolve: true, noLib: true, types: [] }, files: [f] });
  const api = new API({
    cwd: process.cwd(),
    fs: {
      fileExists: (fn) => (resolve(fn) === CONFIG_PATH || virtual.has(resolve(fn)) ? true : undefined),
      readFile: (fn) => (resolve(fn) === CONFIG_PATH ? config : virtual.get(resolve(fn))),
    },
  });
  try {
    const program = api.updateSnapshot({ openProjects: [CONFIG_PATH] }).getProject(CONFIG_PATH).program;
    program.getSourceFile(f);
  } finally {
    api.close();
  }
}

const N = Number(process.argv[2] ?? 20);
for (let i = 0; i < N; i++) once();
console.log(`repro: completed ${N} API open/close cycles`);
