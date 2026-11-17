import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790";

function loadEnvFile() {
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvFile();
const configPath = existsSync(resolve(root, "config/models.json"))
  ? resolve(root, "config/models.json")
  : resolve(root, "config/models.example.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

for (const provider of config.providers) {
  const { apiKeyEnv, ...rest } = provider;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  if (provider.type !== "custom" && !apiKey) {
    console.log(`skip ${provider.type}: ${apiKeyEnv} is not set`);
    continue;
  }
  const manifest = { ...rest };
  if (apiKey) manifest.auth = { api_key: apiKey };
  else if (provider.type === "custom") manifest.auth = { api_key: "not-needed" };
  const res = await fetch(`${baseUrl}/api/v1/settings/model-providers`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest }),
  });
  const body = await res.text();
  console.log(`${provider.name ?? provider.type}: ${res.status}${res.ok ? "" : " " + body.slice(0, 400)}`);
}

const models = await (await fetch(`${baseUrl}/api/v1/models`)).json();
console.log("models available in TrueForge:", models.data.map((m) => m.name).join(", "));
if (config.order) console.log('set VS Code setting "forgepilot.models" to', JSON.stringify(config.order));
