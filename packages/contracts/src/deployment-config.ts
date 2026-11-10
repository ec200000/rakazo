import * as z from "zod";
import { McpHeadersSchema, McpRemoteEndpointSchema } from "./mcp.js";

/**
 * The operator's deployment file (`rakazo.jsonc`): MCP servers, skills and plugins every account
 * gets, and where plugins may come from. The `mcp` block uses the common local/remote shape of
 * agent config files, so an entry can be copied between them.
 */
const EntryName = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?$/,
    "Names use 1-48 lowercase letters, digits, dots, dashes or underscores",
  );

const ServerCommon = {
  description: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
  /** false: each bot must be given the server; true: every bot can use it. */
  allBots: z.boolean().default(true),
};

export const DeploymentRemoteMcpSchema = z
  .object({
    type: z.literal("remote"),
    url: McpRemoteEndpointSchema,
    transport: z.enum(["streamable-http", "sse"]).default("streamable-http"),
    headers: McpHeadersSchema.default({}),
    ...ServerCommon,
  })
  .strict();

export const DeploymentLocalMcpSchema = z
  .object({
    type: z.literal("local"),
    /** The program and its arguments, as one array. */
    command: z.array(z.string().min(1).max(2048)).min(1).max(65),
    environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4096)).default({}),
    ...ServerCommon,
  })
  .strict();

export const DeploymentMcpSchema = z.discriminatedUnion("type", [
  DeploymentRemoteMcpSchema,
  DeploymentLocalMcpSchema,
]);

/** Inline text, or a SKILL.md file (or a folder holding one) on the server's disk. */
export const DeploymentSkillSchema = z.union([
  z
    .object({
      description: z.string().min(1).max(2000),
      content: z.string().max(100_000),
    })
    .strict(),
  z.object({ path: z.string().startsWith("/").max(4096) }).strict(),
]);

/** Credentials for a git host plugins and marketplaces may be read from. */
export const DeploymentGitHostSchema = z
  .object({
    token: z.string().min(1).max(4096).optional(),
    /** Sent with the token as HTTP basic auth; most git servers accept any name with a token. */
    username: z.string().min(1).max(200).default("oauth2"),
  })
  .strict();

const HttpsGitUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"), "Must be an https:// git URL");

export const DeploymentConfigSchema = z
  .object({
    $schema: z.string().optional(),
    mcp: z.record(EntryName, DeploymentMcpSchema).default({}),
    skills: z.record(EntryName, DeploymentSkillSchema).default({}),
    /** Plugin sources installed for everyone: https git URLs (`@ref`, `#subdir`) or absolute paths. */
    plugins: z
      .array(z.union([HttpsGitUrl, z.string().startsWith("/").max(4096, "Paths must be absolute")]))
      .max(50)
      .default([]),
    /** Plugin catalogs offered in Integrations, besides or instead of the built-in ones. */
    marketplaces: z
      .array(z.object({ name: z.string().trim().min(1).max(60), url: HttpsGitUrl }).strict())
      .max(20)
      .default([]),
    /** false hides the built-in public catalogs. */
    defaultMarketplaces: z.boolean().default(true),
    git: z
      .object({
        /** Hosts plugins and marketplaces may come from, besides github.com, by hostname. */
        hosts: z.record(z.string().min(1).max(253), DeploymentGitHostSchema).default({}),
      })
      .strict()
      .default({ hosts: {} }),
  })
  .strict();

export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;
export type DeploymentMcp = z.infer<typeof DeploymentMcpSchema>;
export type DeploymentSkill = z.infer<typeof DeploymentSkillSchema>;
export type DeploymentGitHost = z.infer<typeof DeploymentGitHostSchema>;
