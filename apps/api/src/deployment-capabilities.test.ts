import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeploymentConfigSchema } from "@rakazo/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { configServers, deploymentUnits, isDeploymentInstall } from "./deployment-capabilities.js";

const schema = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
const root = mkdtempSync(join(tmpdir(), "deployment-units-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function config(input: unknown) {
  return DeploymentConfigSchema.parse(input);
}

describe("configServers", () => {
  it("maps remote and local entries to the inputs the MCP routes take", () => {
    const servers = configServers(
      config({
        mcp: {
          docs: {
            type: "remote",
            url: "http://docs.internal.example/mcp",
            transport: "sse",
            headers: { Authorization: "Bearer x" },
          },
          files: {
            type: "local",
            command: ["npx", "-y", "@example/files@1.0.0", "/srv"],
            environment: { TOKEN: "y" },
            allBots: false,
            enabled: false,
          },
        },
      }),
    );
    expect(servers).toEqual([
      {
        name: "docs",
        allBots: true,
        input: expect.objectContaining({
          transport: "sse",
          endpoint: "http://docs.internal.example/mcp",
          headers: { Authorization: "Bearer x" },
          enabled: true,
        }),
      },
      {
        name: "files",
        allBots: false,
        input: expect.objectContaining({
          transport: "stdio",
          command: "npx",
          args: ["-y", "@example/files@1.0.0", "/srv"],
          env: { TOKEN: "y" },
          enabled: false,
        }),
      },
    ]);
  });
});

describe("deploymentUnits", () => {
  it("makes one unit for the file's own entries, versioned by content and policy", async () => {
    const file = config({
      mcp: { docs: { type: "remote", url: "https://docs.example.test/mcp" } },
      skills: { triage: { description: "Triage a pod", content: "Check events." } },
    });
    const [unit] = await deploymentUnits(file, undefined, { private: false });
    expect(unit).toMatchObject({
      source: "deployment:config",
      skills: [{ name: "triage", description: "Triage a pod" }],
      servers: [{ name: "docs" }],
    });
    const [same] = await deploymentUnits(file, undefined, { private: false });
    const [otherPolicy] = await deploymentUnits(file, undefined, { private: true });
    expect(same && "digest" in same && same.digest).toBe(unit && "digest" in unit && unit.digest);
    expect(otherPolicy && "digest" in otherPolicy && otherPolicy.digest).not.toBe(
      unit && "digest" in unit && unit.digest,
    );
  });

  it("reads plugin folders and keeps an unreadable plugin's install as it was", async () => {
    const dir = join(root, "plugin");
    mkdirSync(join(dir, "skills", "runbook"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ $schema: schema, name: "ops" }));
    writeFileSync(
      join(dir, "skills", "runbook", "SKILL.md"),
      "---\nname: runbook\ndescription: Follow the runbook\n---\n\nSteps.\n",
    );
    const units = await deploymentUnits(
      config({ plugins: [dir, "https://git.example.test/team/plugins"] }),
      () => Promise.reject(new Error("unreachable")),
      {},
    );
    expect(units).toEqual([
      expect.objectContaining({
        source: `deployment:plugin:${dir}`,
        name: "ops",
        skills: [expect.objectContaining({ name: "runbook" })],
      }),
      { source: "deployment:plugin:https://git.example.test/team/plugins", unavailable: true },
    ]);
  });

  it("makes no unit for an empty file", async () => {
    expect(await deploymentUnits(config({}), undefined, {})).toEqual([]);
  });
});

describe("isDeploymentInstall", () => {
  it("recognises only installs the file owns", () => {
    expect(isDeploymentInstall({ source: "deployment:config" })).toBe(true);
    expect(isDeploymentInstall({ source: "https://github.com/a/b" })).toBe(false);
    expect(isDeploymentInstall(null)).toBe(false);
  });
});
