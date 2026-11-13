import { describe, expect, it } from "vitest";
import {
  mirroredImage,
  packageMirrorEnv,
  packageMirrorHomeFiles,
  packageMirrorsFromEnv,
} from "./package-mirrors.js";

const SETTING = JSON.stringify({
  npm: "https://af.example/artifactory/api/npm/npm-remote/",
  maven: "https://af.example/artifactory/maven-remote",
  helm: "https://af.example/artifactory/api/helm/helm-remote",
  images: "af.example/docker-remote",
  bogus: "x",
});

describe("package mirrors", () => {
  it("reads the deployment setting and ignores what is not a mirror", () => {
    expect(packageMirrorsFromEnv({ RAKAZO_PACKAGE_MIRRORS: SETTING })).toEqual({
      npm: "https://af.example/artifactory/api/npm/npm-remote/",
      maven: "https://af.example/artifactory/maven-remote",
      gradlePlugins: undefined,
      helm: "https://af.example/artifactory/api/helm/helm-remote",
      images: "af.example/docker-remote",
    });
    expect(packageMirrorsFromEnv({ RAKAZO_PACKAGE_MIRRORS: "not json" })).toEqual({});
    expect(
      packageMirrorsFromEnv({ RAKAZO_PACKAGE_MIRRORS: '{"npm":"ftp://x","images":"a b"}' }),
    ).toEqual({
      npm: undefined,
      maven: undefined,
      gradlePlugins: undefined,
      helm: undefined,
      images: undefined,
    });
  });

  it("sets npm, yarn, corepack and the Maven wrapper through the environment", () => {
    const env = packageMirrorEnv(packageMirrorsFromEnv({ RAKAZO_PACKAGE_MIRRORS: SETTING }));
    expect(env).toMatchObject({
      NPM_CONFIG_REGISTRY: "https://af.example/artifactory/api/npm/npm-remote/",
      YARN_NPM_REGISTRY_SERVER: "https://af.example/artifactory/api/npm/npm-remote/",
      COREPACK_NPM_REGISTRY: "https://af.example/artifactory/api/npm/npm-remote",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      MVNW_REPOURL: "https://af.example/artifactory/maven-remote",
      JAVA_HOME_17: "/opt/java/17",
    });
    expect(packageMirrorEnv({})).toEqual({
      JAVA_HOME_17: "/opt/java/17",
      JAVA_HOME_21: "/opt/java/21",
    });
  });

  it("writes Maven, Gradle and Helm settings into the home", () => {
    const files = packageMirrorHomeFiles(
      packageMirrorsFromEnv({ RAKAZO_PACKAGE_MIRRORS: SETTING }),
    );
    expect(files.map((file) => file.path)).toEqual([
      ".m2/toolchains.xml",
      ".m2/settings.xml",
      ".gradle/init.d/rakazo-mirrors.gradle",
      ".config/helm/repositories.yaml",
    ]);
    const content = Object.fromEntries(files.map((file) => [file.path, file.content]));
    expect(content[".m2/settings.xml"]).toContain("<mirrorOf>*</mirrorOf>");
    expect(content[".m2/settings.xml"]).toContain(
      "<url>https://af.example/artifactory/maven-remote</url>",
    );
    expect(content[".gradle/init.d/rakazo-mirrors.gradle"]).toContain(
      'def rakazoPlugins = "https://af.example/artifactory/maven-remote"',
    );
    expect(content[".config/helm/repositories.yaml"]).toContain("name: artifactory");
    expect(packageMirrorHomeFiles({}).map((file) => file.path)).toEqual([".m2/toolchains.xml"]);
  });

  it("pulls images through the image mirror unless they name a registry", () => {
    const mirrors = { images: "af.example/docker-remote" };
    expect(mirroredImage("postgres:16", mirrors)).toBe(
      "af.example/docker-remote/library/postgres:16",
    );
    expect(mirroredImage("bitnami/redis:7", mirrors)).toBe(
      "af.example/docker-remote/bitnami/redis:7",
    );
    expect(mirroredImage("registry.internal/app/db:1", mirrors)).toBe("registry.internal/app/db:1");
    expect(mirroredImage("postgres:16", {})).toBe("postgres:16");
  });
});
