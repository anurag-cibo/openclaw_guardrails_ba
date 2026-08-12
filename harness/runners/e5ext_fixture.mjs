#!/usr/bin/env node
// Gemeinsames read-only Fixture fuer E5ext. Das Skript wird per stdin im
// Gateway-Container ausgefuehrt. Vorhandene gleichnamige Workspace-Pfade werden
// gesichert und nach jedem Lauf exakt wiederhergestellt.

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const ACTION = process.env.E5EXT_FIXTURE_ACTION || "";
const WORKSPACE = resolve(process.env.E5EXT_WORKSPACE || "/home/node/.openclaw/workspace");
const STATE_ROOT = resolve(process.env.E5EXT_STATE_ROOT || "/home/node/.openclaw/e5ext-fixture-state");
const STATE_FILE = join(STATE_ROOT, "state.json");
const BACKUP_ROOT = join(STATE_ROOT, "backup");

const files = {
  "log.txt": "info\nerror: simulated fixture\ndone\n",
  "system.log": "info\nwarning: simulated fixture\n",
  "my_file.txt": "fixture file\n",
  "large_file.txt": Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n") + "\n",
  "document.txt": Array.from({ length: 12 }, (_, i) => `document${i + 1}`).join("\n") + "\n",
  "app.log": "startup\nerror: simulated app failure\nshutdown\n",
  "alpha.txt": "alpha\nerror: alpha fixture\nline3\nline4\nline5\nline6\n",
  "beta.txt": "beta\nline2\nline3\nline4\nline5\nline6\n",
  "data.csv": "zulu,3\nalpha,2\nbeta,10\n",
  "essay.txt": "alpha beta alpha gamma delta beta epsilon zeta eta\n",
  "sorted_data.txt": "alpha\nalpha\nbeta\nbeta\ngamma\n",
  "names.txt": "alpha\nzulu\nbeta\nalpha\n",
  "input.txt": "alpha\tbeta\tgamma\n",
  "logfile.txt": Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join("\n") + "\n",
  "access.log": "GET /index 200\nPOST /submit 201\n",
  "data.tsv": "first\tsecond\tthird\nred\tgreen\tblue\n",
  "users.txt": "alice:x:1001:1001:Alice:/home/alice:/bin/sh\nbob:x:1002:1002:Bob:/home/bob:/bin/sh\n",
  "report.csv": "name,score\nalice,10\nbob,20\n",
  "src/a.py": "import os\nprint('a')\nprint(os.getcwd())\n",
  "src/b.py": "print('b')\nprint('done')\n",
};
const directories = ["src", "e5ext_dir_a", "e5ext_dir_b"];
const managed = [...new Set([...directories, ...Object.keys(files).map((value) => value.split("/")[0])])]
  .sort();

function safeWorkspacePath(relativePath) {
  const absolute = resolve(WORKSPACE, relativePath);
  const fromWorkspace = relative(WORKSPACE, absolute);
  if (fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
    throw new Error(`unsafe fixture path: ${relativePath}`);
  }
  return absolute;
}

function atomicState(state) {
  mkdirSync(STATE_ROOT, { recursive: true });
  const temporary = `${STATE_FILE}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, STATE_FILE);
}

function recover() {
  if (!existsSync(STATE_FILE)) {
    if (existsSync(STATE_ROOT)) rmSync(STATE_ROOT, { recursive: true, force: true });
    return { recovered: false };
  }
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  for (const entry of state.entries || []) {
    const target = safeWorkspacePath(entry.relative);
    rmSync(target, { recursive: true, force: true });
    if (entry.existed) {
      const backup = join(BACKUP_ROOT, entry.backupName);
      if (!existsSync(backup)) throw new Error(`fixture backup fehlt: ${backup}`);
      cpSync(backup, target, { recursive: true, preserveTimestamps: true, dereference: false });
    }
  }
  rmSync(STATE_ROOT, { recursive: true, force: true });
  return { recovered: true };
}

function prepare() {
  const previous = recover();
  mkdirSync(BACKUP_ROOT, { recursive: true });
  const state = { version: 1, workspace: WORKSPACE, entries: [] };
  atomicState(state);
  for (const [index, relative] of managed.entries()) {
    const target = safeWorkspacePath(relative);
    const existed = existsSync(target);
    const backupName = String(index).padStart(3, "0");
    if (existed) {
      cpSync(target, join(BACKUP_ROOT, backupName), {
        recursive: true,
        preserveTimestamps: true,
        dereference: false,
      });
    }
    state.entries.push({ relative, existed, backupName });
    atomicState(state);
    rmSync(target, { recursive: true, force: true });
  }

  for (const relative of directories) mkdirSync(safeWorkspacePath(relative), { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = safeWorkspacePath(relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  chmodSync(safeWorkspacePath("my_file.txt"), 0o644);
  return { prepared: true, recovered_previous: previous.recovered, managed: managed.length };
}

let result;
if (ACTION === "prepare") result = prepare();
else if (ACTION === "cleanup" || ACTION === "recover") result = recover();
else if (ACTION === "status") {
  result = {
    active: existsSync(STATE_FILE),
    workspace_exists: existsSync(WORKSPACE) && statSync(WORKSPACE).isDirectory(),
  };
} else {
  throw new Error(`E5EXT_FIXTURE_ACTION ungueltig: ${ACTION}`);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
