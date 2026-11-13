/**
 * Package mirrors for bot computers in a network without internet: one deployment setting,
 * RAKAZO_PACKAGE_MIRRORS (JSON), becomes environment variables on every computer pod (npm, pnpm,
 * yarn, corepack, the Maven wrapper) and settings files written into each computer's home when it
 * starts (Maven, Gradle, Helm). Each is optional; an Artifactory remote or virtual repository URL
 * is the usual value.
 */

export type PackageMirrors = {
  /** npm registry, e.g. https://artifactory.example/artifactory/api/npm/npm-remote/ */
  npm?: string;
  /** Maven repository mirroring Maven Central (also the Maven wrapper's download). */
  maven?: string;
  /** Gradle plugin portal mirror; the Maven mirror when not given. */
  gradlePlugins?: string;
  /** Helm chart repository. */
  helm?: string;
  /** Registry prefix for container images, e.g. artifactory.example/docker-remote. */
  images?: string;
};

function url(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** The deployment's mirrors; an invalid or missing setting means none. */
export function packageMirrorsFromEnv(env: NodeJS.ProcessEnv = process.env): PackageMirrors {
  const raw = env.RAKAZO_PACKAGE_MIRRORS?.trim();
  if (!raw) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  const images =
    typeof parsed.images === "string" &&
    /^[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._-]+)*$/.test(parsed.images.trim())
      ? parsed.images.trim().replace(/\/+$/, "")
      : undefined;
  return {
    npm: url(parsed.npm),
    maven: url(parsed.maven),
    gradlePlugins: url(parsed.gradlePlugins),
    helm: url(parsed.helm),
    images,
  };
}

/** Environment variables for computer pods. */
export function packageMirrorEnv(mirrors: PackageMirrors): Record<string, string> {
  const env: Record<string, string> = {
    // Java 21 is the default; 17 is beside it for projects that need it.
    JAVA_HOME_17: "/opt/java/17",
    JAVA_HOME_21: "/opt/java/21",
  };
  if (mirrors.npm) {
    Object.assign(env, {
      NPM_CONFIG_REGISTRY: mirrors.npm,
      YARN_REGISTRY: mirrors.npm,
      YARN_NPM_REGISTRY_SERVER: mirrors.npm,
      COREPACK_NPM_REGISTRY: mirrors.npm.replace(/\/+$/, ""),
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    });
  }
  // The Maven wrapper downloads Maven itself from here.
  if (mirrors.maven) Object.assign(env, { MVNW_REPOURL: mirrors.maven.replace(/\/+$/, "") });
  return env;
}

function xml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Settings files written into each computer's home (paths relative to it). */
export function packageMirrorHomeFiles(
  mirrors: PackageMirrors,
): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [
    {
      path: ".m2/toolchains.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by Rakazo: the JDKs in this computer. -->
<toolchains>
  <toolchain><type>jdk</type><provides><version>17</version></provides><configuration><jdkHome>/opt/java/17</jdkHome></configuration></toolchain>
  <toolchain><type>jdk</type><provides><version>21</version></provides><configuration><jdkHome>/opt/java/21</jdkHome></configuration></toolchain>
</toolchains>
`,
    },
  ];
  if (mirrors.maven) {
    files.push({
      path: ".m2/settings.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by Rakazo: every Maven repository is read through the mirror. -->
<settings>
  <mirrors>
    <mirror>
      <id>rakazo-mirror</id>
      <mirrorOf>*</mirrorOf>
      <url>${xml(mirrors.maven)}</url>
    </mirror>
  </mirrors>
</settings>
`,
    });
    const plugins = mirrors.gradlePlugins ?? mirrors.maven;
    files.push({
      path: ".gradle/init.d/rakazo-mirrors.gradle",
      content: `// Written by Rakazo: every Maven repository a build declares (mavenCentral(), google(), the
// plugin portal) is read through the mirrors instead.
def rakazoMirror = ${JSON.stringify(mirrors.maven)}
def rakazoPlugins = ${JSON.stringify(plugins)}
def rakazoRedirect = { repos, target ->
  repos.all { repo ->
    if (repo instanceof MavenArtifactRepository && repo.url.toString() != target) {
      repo.url = target
    }
  }
}
beforeSettings { settings ->
  rakazoRedirect(settings.pluginManagement.repositories, rakazoPlugins)
  try {
    rakazoRedirect(settings.dependencyResolutionManagement.repositories, rakazoMirror)
  } catch (ignored) {
  }
}
allprojects {
  rakazoRedirect(buildscript.repositories, rakazoMirror)
  rakazoRedirect(repositories, rakazoMirror)
}
`,
    });
  }
  if (mirrors.helm) {
    files.push({
      path: ".config/helm/repositories.yaml",
      content: `# Written by Rakazo: charts come through the mirror ("helm pull artifactory/<chart>").
apiVersion: ""
generated: "0001-01-01T00:00:00Z"
repositories:
  - name: artifactory
    url: ${JSON.stringify(mirrors.helm)}
`,
    });
  }
  return files;
}

/** An image reference through the image mirror: `postgres:16` → `<mirror>/library/postgres:16`. */
export function mirroredImage(image: string, mirrors: PackageMirrors): string {
  const reference = image.trim();
  if (!mirrors.images) return reference;
  const first = reference.split("/")[0] ?? "";
  // Already names a registry (a host with a dot or port, or localhost): keep it.
  if (
    reference.includes("/") &&
    (first.includes(".") || first.includes(":") || first === "localhost")
  ) {
    return reference;
  }
  const path = reference.includes("/") ? reference : `library/${reference}`;
  return `${mirrors.images}/${path}`;
}
