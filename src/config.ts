import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function getZooHome(): string {
  return process.env.ZOO_HOME || join(homedir(), ".local", "share", "zoo");
}

export function dbPath(): string {
  return join(getZooHome(), "zoo.db");
}

export function storePath(): string {
  return join(getZooHome(), "store");
}

function configPath(): string {
  return join(getZooHome(), "config.json");
}

export function ensureDirs(): void {
  const home = getZooHome();
  mkdirSync(home, { recursive: true });
  mkdirSync(storePath(), { recursive: true });
}

function readConfig(): Record<string, string> {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, string>): void {
  const path = configPath();
  mkdirSync(getZooHome(), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

export function getApiKey(): string {
  const envKey = process.env.ZOO_API_KEY;
  if (envKey) return envKey;
  const config = readConfig();
  if (config["api-key"]) return config["api-key"];
  throw new Error("No API key. Set ZOO_API_KEY or run: zoo config set api-key <KEY>");
}

export function getConfigValue(key: string): string | undefined {
  if (key === "api-key") {
    const envKey = process.env.ZOO_API_KEY;
    if (envKey) return envKey;
  }
  return readConfig()[key];
}

export function setConfigValue(key: string, value: string): void {
  const config = readConfig();
  config[key] = value;
  writeConfig(config);
}
