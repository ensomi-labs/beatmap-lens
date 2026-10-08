import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

/** Use the regression gate's selector, including duplicate and conflict handling. */
export async function buildGoldenSet(feedbacks) {
  const script = [
    "import json, sys",
    "sys.path.insert(0, 'annotation/evaluation')",
    "from high_confidence_suite import build_suite",
    "try:",
    "    suite = build_suite(json.load(sys.stdin), 'inspector-current-golden-set')",
    "    print(json.dumps({'cases': suite['cases']}))",
    "except ValueError as error:",
    "    print(json.dumps({'cases': [], 'gateError': str(error)}))",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "--locked", "python", "-c", script], { cwd: repo });
    let output = "";
    let error = "";
    child.stdout.setEncoding("utf8").on("data", (text) => {
      output += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text) => {
      error += text;
    });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(error.trim() || "Could not read the agent gate's golden set."));
      try {
        resolve(JSON.parse(output));
      } catch (cause) {
        reject(cause);
      }
    });
    child.stdin.end(JSON.stringify(feedbacks));
  });
}
