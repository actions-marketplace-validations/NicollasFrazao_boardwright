import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);

// packages/runner/src/action.ts
import { spawn } from "node:child_process";
import { readFile as readFile2 } from "node:fs/promises";
import {
  dirname as dirname2,
  join as join3
} from "node:path";
import { fileURLToPath } from "node:url";

// packages/runner/src/action-inputs.ts
import { join } from "node:path";
var ActionInputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ActionInputError";
  }
};
var RUNTIME_CREDENTIALS = /* @__PURE__ */ new Set([
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_CACHE_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL"
]);
var INPUT_PREFIX = "INPUT_";
var TRUE_VALUES = /* @__PURE__ */ new Set([
  "true",
  "True",
  "TRUE"
]);
var FALSE_VALUES = /* @__PURE__ */ new Set([
  "false",
  "False",
  "FALSE",
  ""
]);
function actionCommand(variables) {
  const input = (name) => variables[`${INPUT_PREFIX}${name.toUpperCase()}`]?.trim() ?? "";
  const githubToken = input("github-token");
  if (githubToken === "") {
    throw new ActionInputError("The github-token input is required: a token that can read the board and write to the repositories.");
  }
  const environment = {};
  for (const [
    name,
    value
  ] of Object.entries(variables)) {
    if (value !== void 0 && !name.startsWith(INPUT_PREFIX) && !RUNTIME_CREDENTIALS.has(name)) {
      environment[name] = value;
    }
  }
  environment.BOARDWRIGHT_GITHUB_TOKEN = githubToken;
  const mergeToken = input("merge-token");
  if (mergeToken !== "") {
    environment.BOARDWRIGHT_MERGE_TOKEN = mergeToken;
  }
  const appId = input("app-id");
  const appKey = input("app-private-key");
  if (appId !== "") {
    environment.BOARDWRIGHT_APP_ID = appId;
  }
  if (appKey !== "") {
    environment.BOARDWRIGHT_APP_PRIVATE_KEY = appKey;
  }
  const runnerTemp = variables.RUNNER_TEMP;
  if (environment.BOARDWRIGHT_CACHE_DIR === void 0 && runnerTemp !== void 0) {
    environment.BOARDWRIGHT_CACHE_DIR = join(
      runnerTemp,
      "boardwright"
    );
  }
  const config = input("config");
  return {
    argv: [
      "once",
      ...config === "" ? [] : [
        "--config",
        config
      ],
      ...isDryRun(input("dry-run")) ? ["--dry-run"] : []
    ],
    environment
  };
}
function isDryRun(value) {
  if (TRUE_VALUES.has(value)) {
    return true;
  }
  if (FALSE_VALUES.has(value)) {
    return false;
  }
  throw new ActionInputError(`The dry-run input must be true or false, not "${value}".`);
}

// packages/runner/src/agent-packages.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import {
  dirname,
  join as join2
} from "node:path";
import { promisify } from "node:util";
var run = promisify(execFile);
var UnsupportedMachineError = class extends Error {
  constructor(machine2) {
    super(`The Claude Agent SDK has no native binary for ${[
      machine2.platform,
      machine2.arch,
      machine2.libc
    ].filter((part) => part !== void 0).join("-")}.`);
    this.name = "UnsupportedMachineError";
  }
};
var IntegrityError = class extends Error {
  constructor(source) {
    super(`The tarball of ${source.name}@${source.version} does not match the integrity pinned in package-lock.json; nothing was installed.`);
    this.name = "IntegrityError";
  }
};
function selectPackages(pinned, machine2) {
  const common = pinned.filter((source) => source.os === void 0);
  const binary = pinned.find((source) => source.os !== void 0 && matches(
    source.os,
    machine2.platform
  ) && matches(
    source.cpu,
    machine2.arch
  ) && matches(
    source.libc,
    machine2.libc
  ));
  if (binary === void 0) {
    throw new UnsupportedMachineError(machine2);
  }
  return [
    ...common,
    binary
  ];
}
function matches(allowed, value) {
  return allowed === void 0 || value === void 0 || allowed.includes(value);
}
function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
async function installPackages(packages, store) {
  const installed = [];
  for (const source of packages) {
    if (await store.installedVersion(source.name) === source.version) {
      continue;
    }
    const tarball = await store.download(source.url);
    if (integrityOf(tarball) !== source.integrity) {
      throw new IntegrityError(source);
    }
    await store.unpack(
      source.name,
      tarball
    );
    installed.push(`${source.name}@${source.version}`);
  }
  return installed;
}
function diskPackageStore(options) {
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    installedVersion: async (name) => {
      try {
        const manifest = JSON.parse(await readFile(
          join2(
            options.directory,
            name,
            "package.json"
          ),
          "utf8"
        ));
        return typeof manifest.version === "string" ? manifest.version : void 0;
      } catch {
        return void 0;
      }
    },
    download: async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Downloading ${url} failed: HTTP ${String(response.status)}.`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    unpack: (name, tarball) => unpackInto(
      join2(
        options.directory,
        name
      ),
      tarball
    )
  };
}
async function unpackInto(destination, tarball) {
  await mkdir(
    dirname(destination),
    { recursive: true }
  );
  const staging = await mkdtemp(`${destination}.staging-`);
  try {
    const archive = join2(
      staging,
      "package.tgz"
    );
    await writeFile(
      archive,
      tarball
    );
    await run(
      "tar",
      [
        "-xzf",
        archive,
        "-C",
        staging
      ]
    );
    await rm(
      destination,
      {
        recursive: true,
        force: true
      }
    );
    await rename(
      join2(
        staging,
        "package"
      ),
      destination
    );
  } finally {
    await rm(
      staging,
      {
        recursive: true,
        force: true
      }
    );
  }
}

// packages/runner/src/action.ts
var EXIT_USAGE = 2;
var bundle = dirname2(fileURLToPath(import.meta.url));
function machine() {
  if (process.platform !== "linux") {
    return {
      platform: process.platform,
      arch: process.arch,
      libc: void 0
    };
  }
  const report = process.report.getReport();
  return {
    platform: process.platform,
    arch: process.arch,
    libc: report.header?.glibcVersionRuntime === void 0 ? "musl" : "glibc"
  };
}
function runCli(command) {
  const child = spawn(
    process.execPath,
    [
      join3(
        bundle,
        "cli.js"
      ),
      ...command.argv
    ],
    {
      env: command.environment,
      stdio: "inherit"
    }
  );
  for (const signal of [
    "SIGINT",
    "SIGTERM"
  ]) {
    process.on(
      signal,
      () => child.kill(signal)
    );
  }
  return new Promise((resolve, reject) => {
    child.once(
      "error",
      reject
    );
    child.once(
      "exit",
      (code) => {
        resolve(code ?? 1);
      }
    );
  });
}
try {
  const command = actionCommand(process.env);
  const pinned = JSON.parse(await readFile2(
    join3(
      bundle,
      "agent-packages.json"
    ),
    "utf8"
  ));
  const installed = await installPackages(
    selectPackages(
      pinned,
      machine()
    ),
    diskPackageStore({
      directory: join3(
        bundle,
        "node_modules"
      )
    })
  );
  for (const name of installed) {
    process.stdout.write(`Installed ${name}
`);
  }
  process.exitCode = await runCli(command);
} catch (error) {
  if (error instanceof ActionInputError || error instanceof IntegrityError || error instanceof UnsupportedMachineError) {
    process.stdout.write(`::error::${error.message}
`);
    process.exitCode = EXIT_USAGE;
  } else {
    throw error;
  }
}
