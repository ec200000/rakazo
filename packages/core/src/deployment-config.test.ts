import { describe, expect, it } from "vitest";
import { DeploymentConfigError, parseDeploymentConfig } from "./deployment-config.js";

const sources = {
  env: { DOCS_TOKEN: "s3cret", GIT_TOKEN: "glpat-x" },
  readFile: (path: string) => {
    if (path === "/run/secrets/token") return "from-file\n";
    throw new Error("missing");
  },
};

describe("parseDeploymentConfig", () => {
  it("reads JSONC with comments and trailing commas, and fills placeholders", () => {
    const config = parseDeploymentConfig(
      `{
        // Every account gets these.
        "mcp": {
          "docs": {
            "type": "remote",
            "url": "https://docs.example.test/mcp",
            "headers": { "Authorization": "Bearer {env:DOCS_TOKEN}" },
          },
          "files": {
            "type": "local",
            "command": ["npx", "-y", "@example/files-mcp@1.2.3", "/srv/shared"],
            "environment": { "TOKEN": "{file:/run/secrets/token}" },
            "allBots": false,
          },
        },
        "skills": {
          "release-notes": { "description": "Write release notes", "content": "Steps." },
        },
        "plugins": ["https://git.example.test/team/plugins#k8s"],
        "git": { "hosts": { "git.example.test": { "token": "{env:GIT_TOKEN}" } } },
      }`,
      sources,
    );
    expect(config.mcp.docs).toEqual({
      type: "remote",
      url: "https://docs.example.test/mcp",
      transport: "streamable-http",
      headers: { Authorization: "Bearer s3cret" },
      enabled: true,
      allBots: true,
    });
    expect(config.mcp.files).toMatchObject({
      type: "local",
      environment: { TOKEN: "from-file" },
      allBots: false,
    });
    expect(config.git.hosts["git.example.test"]).toEqual({ token: "glpat-x", username: "oauth2" });
    expect(config.defaultMarketplaces).toBe(true);
    expect(config.marketplaces).toEqual([]);
  });

  it("accepts an empty file body", () => {
    expect(parseDeploymentConfig("{}", sources)).toMatchObject({
      mcp: {},
      skills: {},
      plugins: [],
    });
  });

  it("names the setting at fault", () => {
    expect(() =>
      parseDeploymentConfig(
        `{ "mcp": { "x": { "type": "remote", "url": "{env:NOPE}" } } }`,
        sources,
      ),
    ).toThrow(new DeploymentConfigError("config.mcp.x.url: environment variable NOPE is not set"));
    expect(() =>
      parseDeploymentConfig(`{ "mcp": { "x": { "type": "local", "command": [] } } }`, sources),
    ).toThrow(/^config\.mcp\.x\.command: /);
    expect(() => parseDeploymentConfig(`{ "mpc": {} }`, sources)).toThrow(/config: .*mpc/);
    expect(() =>
      parseDeploymentConfig(`{ "plugins": ["http://git.example.test/a/b"] }`, sources),
    ).toThrow(/^config\.plugins\.0: /);
    expect(() => parseDeploymentConfig("{ nope", sources)).toThrow(/^not valid JSONC/);
  });

  it("refuses relative file placeholders and unreadable files", () => {
    expect(() =>
      parseDeploymentConfig(
        `{ "skills": { "a": { "description": "{file:token}", "content": "" } } }`,
        sources,
      ),
    ).toThrow("config.skills.a.description: {file:token} must be an absolute path");
    expect(() =>
      parseDeploymentConfig(
        `{ "skills": { "a": { "description": "{file:/nope}", "content": "" } } }`,
        sources,
      ),
    ).toThrow("config.skills.a.description: could not read /nope");
  });
});
