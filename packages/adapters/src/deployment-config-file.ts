/** Loads the operator's `rakazo.jsonc` (path in RAKAZO_CONFIG_FILE) once per process. */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DeploymentConfig } from "@rakazo/contracts";
import {
  buildSkillMd,
  DeploymentConfigError,
  parseDeploymentConfig,
  parseSkillMd,
} from "@rakazo/core";
import type { PluginSkillEntry } from "./plugin-connectors.js";

let loaded: { path: string; config: DeploymentConfig } | null | undefined;

/**
 * Reads and validates the deployment file. Returns null when RAKAZO_CONFIG_FILE is unset.
 * Throws DeploymentConfigError for a file that is missing or invalid, so the process stops
 * with a message naming the setting instead of starting without what the operator asked for.
 */
export function loadDeploymentConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentConfig | null {
  const path = env.RAKAZO_CONFIG_FILE?.trim();
  if (!path) return null;
  if (loaded?.path === path) return loaded.config;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new DeploymentConfigError(`${path}: could not read the file`);
  }
  try {
    const config = parseDeploymentConfig(text, {
      env,
      readFile: (file) => readFileSync(file, "utf8"),
    });
    loaded = { path, config };
    return config;
  } catch (error) {
    if (error instanceof DeploymentConfigError)
      throw new DeploymentConfigError(`${path}: ${error.message}`);
    throw error;
  }
}

/** The file loaded at startup, or null when there is none. */
export function deploymentConfig(): DeploymentConfig | null {
  return loaded?.config ?? null;
}

/**
 * The file's local MCP servers are the operator's own choice, so their programs are allowed
 * without also listing them in MCP_STDIO_ALLOWED_COMMANDS. Call before the env is read.
 */
export function applyDeploymentConfigEnv(
  config: DeploymentConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const commands = Object.values(config.mcp).flatMap((server) =>
    server.type === "local" ? [server.command[0]!.trim()] : [],
  );
  if (!commands.length) return;
  const allowed = (env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  env.MCP_STDIO_ENABLED = "true";
  env.MCP_STDIO_ALLOWED_COMMANDS = [...new Set([...allowed, ...commands])].join(",");
}

/** The file's skills as SKILL.md documents, named by their key. */
export function deploymentSkills(
  config: DeploymentConfig,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  isDirectory: (path: string) => boolean = (path) => statSync(path).isDirectory(),
): PluginSkillEntry[] {
  return Object.entries(config.skills).map(([name, skill]) => {
    if ("content" in skill) {
      const content = buildSkillMd({ name, description: skill.description, body: skill.content });
      return { name, description: skill.description, content };
    }
    const file = isDirectory(skill.path) ? join(skill.path, "SKILL.md") : skill.path;
    let text: string;
    try {
      text = readFile(file);
    } catch {
      throw new DeploymentConfigError(`config.skills.${name}: could not read ${file}`);
    }
    const parsed = parseSkillMd(text);
    if ("error" in parsed)
      throw new DeploymentConfigError(`config.skills.${name}: ${file}: ${parsed.error}`);
    // The key names the skill, so two entries can never collide.
    return {
      name,
      description: parsed.description,
      content: buildSkillMd({ ...parsed, name }),
    };
  });
}
