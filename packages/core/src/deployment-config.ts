import type { DeploymentConfig } from "@rakazo/contracts";
import { DeploymentConfigSchema } from "@rakazo/contracts";
import JSON5 from "json5";

const PLACEHOLDER = /\{(env|file):([^}]+)\}/g;

export type DeploymentConfigSources = {
  env: Readonly<Record<string, string | undefined>>;
  readFile: (path: string) => string;
};

/** Thrown for a file the operator must fix; the message names the setting at fault. */
export class DeploymentConfigError extends Error {
  override name = "DeploymentConfigError";
}

function substitute(value: unknown, at: string, sources: DeploymentConfigSources): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_match, kind: string, ref: string) => {
      const key = ref.trim();
      if (kind === "env") {
        const found = sources.env[key];
        if (found === undefined)
          throw new DeploymentConfigError(`${at}: environment variable ${key} is not set`);
        return found;
      }
      if (!key.startsWith("/"))
        throw new DeploymentConfigError(`${at}: {file:${key}} must be an absolute path`);
      try {
        return sources.readFile(key).replace(/\r?\n$/, "");
      } catch {
        throw new DeploymentConfigError(`${at}: could not read ${key}`);
      }
    });
  }
  if (Array.isArray(value))
    return value.map((item, index) => substitute(item, `${at}[${index}]`, sources));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, `${at}.${key}`, sources)]),
    );
  return value;
}

/**
 * Parses `rakazo.jsonc`: JSON with comments and trailing commas, where any string may hold
 * `{env:NAME}` or `{file:/path}` so credentials stay out of the file itself.
 */
export function parseDeploymentConfig(
  text: string,
  sources: DeploymentConfigSources,
): DeploymentConfig {
  let raw: unknown;
  try {
    raw = JSON5.parse(text);
  } catch (error) {
    throw new DeploymentConfigError(
      `not valid JSONC: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = DeploymentConfigSchema.safeParse(substitute(raw, "config", sources));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = ["config", ...(issue?.path ?? [])].join(".");
    throw new DeploymentConfigError(`${path}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}
