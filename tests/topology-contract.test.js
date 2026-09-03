const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const topologyUrl =
  "https://raw.githubusercontent.com/ROCm/TheRock/main/BUILD_TOPOLOGY.toml";
const sourceFile = "ROCm/TheRock main";

function loadBrowserFunctions() {
  const context = vm.createContext({});
  context.window = context;
  for (const filename of ["toml-parser.js", "topology-model.js"]) {
    vm.runInContext(fs.readFileSync(path.join(projectRoot, filename), "utf8"), context, {
      filename,
    });
  }
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`TheRock returned HTTP ${response.statusCode}`));
        response.resume();
        return;
      }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

function runPythonOracle(source) {
  const args = [
    path.join(__dirname, "build_topology_oracle.py"),
    "-",
    sourceFile,
  ];
  try {
    return execFileSync("python3", args, { encoding: "utf8", input: source });
  } catch (error) {
    // Some restricted runners report EPERM after the child has completed.
    // Accept its result only when it exited successfully and produced JSON.
    if (error.status === 0 && error.stdout) {
      return error.stdout;
    }
    throw error;
  }
}

const browser = loadBrowserFunctions();
const topology = fetchText(topologyUrl).then((source) => ({
  source,
  oracle: JSON.parse(runPythonOracle(source)),
}));

test("the browser TOML parser matches Python tomllib for TheRock main", async () => {
  const { source, oracle } = await topology;
  assert.deepEqual(plain(browser.parseTopologyToml(source)), oracle.parsed);
});

test("the generated graph matches TheRock's latest normalized topology", async () => {
  const { source, oracle } = await topology;
  const parsed = browser.parseTopologyToml(source);
  assert.deepEqual(plain(browser.topologyToGraph(parsed, sourceFile)), oracle.graph);
});

test("the latest topology covers every graph relationship and platform field", async () => {
  const { source } = await topology;
  const graph = plain(browser.topologyToGraph(browser.parseTopologyToml(source), sourceFile));
  assert.deepEqual(
    new Set(graph.edges.map((edge) => edge.kind)),
    new Set([
      "source-requirement",
      "group-dependency",
      "group-membership",
      "artifact-dependency",
      "stage-membership",
    ]),
  );
  assert.ok(
    graph.nodes.some((node) => node.fields.disable_platforms?.includes("windows")),
    "expected at least one artifact unavailable on Windows",
  );
  assert.ok(
    graph.nodes.some((node) => node.fields.platform === "windows"),
    "expected at least one Windows-only artifact",
  );
});
