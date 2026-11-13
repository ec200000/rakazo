# The published computer image with the tools bots need to build, test and deploy code in a
# network without internet: Node.js 22 (npm, with pnpm and yarn through corepack), Java 17 and 21
# (Temurin), Maven, Gradle, Helm, and the OpenShift client (oc, kubectl). Packages come through
# the deployment's mirrors at run time (RAKAZO_PACKAGE_MIRRORS). Built by build-computer.sh.
ARG BASE
FROM ${BASE}
ARG TARGETARCH
ARG NODE_MAJOR=22
ARG MAVEN_VERSION=3.9.9
ARG GRADLE_VERSION=8.14.3
ARG HELM_VERSION=v3.17.3
ARG OC_CHANNEL=stable-4.13
USER root
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) node=x64; jdk=x64; oc=x86_64 ;; \
    arm64) node=arm64; jdk=aarch64; oc=aarch64 ;; \
    *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  mkdir -p /opt/node /opt/java/17 /opt/java/21 /opt/maven /opt/gradle /opt/cluster/bin; \
  dist="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; \
  file=$(curl -fsSL "$dist/SHASUMS256.txt" | awk -v a="linux-$node.tar.gz" '$2 ~ a"$" {print $2; exit}'); \
  curl -fsSL "$dist/$file" | tar -xz -C /opt/node --strip-components=1; \
  /opt/node/bin/node /opt/node/bin/corepack enable --install-directory /opt/node/bin; \
  for v in 17 21; do \
    curl -fsSL "https://api.adoptium.net/v3/binary/latest/$v/ga/linux/$jdk/jdk/hotspot/normal/eclipse" \
      | tar -xz -C "/opt/java/$v" --strip-components=1; \
  done; \
  curl -fsSL "https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
    | tar -xz -C /opt/maven --strip-components=1; \
  curl -fsSL -o /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip"; \
  python3 -m zipfile -e /tmp/gradle.zip /tmp/gradle; \
  mv "/tmp/gradle/gradle-${GRADLE_VERSION}"/* /opt/gradle/; rm -rf /tmp/gradle /tmp/gradle.zip; \
  chmod +x /opt/gradle/bin/gradle; \
  curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
    | tar -xz -C /opt/cluster/bin --strip-components=1 "linux-${TARGETARCH}/helm"; \
  curl -fsSL "https://mirror.openshift.com/pub/openshift-v4/$oc/clients/ocp/${OC_CHANNEL}/openshift-client-linux.tar.gz" \
    | tar -xz -C /opt/cluster/bin oc kubectl; \
  chmod -R a+rX /opt/node /opt/java /opt/maven /opt/gradle /opt/cluster; \
  for tool in /opt/node/bin/* /opt/java/21/bin/java /opt/java/21/bin/javac /opt/java/21/bin/jar \
    /opt/maven/bin/mvn /opt/gradle/bin/gradle /opt/cluster/bin/*; do \
    ln -sf "$tool" "/usr/local/bin/$(basename "$tool")"; \
  done; \
  printf '%s\n' \
    '# Written by the Rakazo computer image: build tools for login shells too.' \
    'export JAVA_HOME=/opt/java/21 NPM_CONFIG_PREFIX="$HOME/.npm-global"' \
    'export GRADLE_OPTS="-Dorg.gradle.java.installations.paths=/opt/java/17,/opt/java/21"' \
    'export PATH="$HOME/.npm-global/bin:/opt/node/bin:/opt/java/21/bin:/opt/maven/bin:/opt/gradle/bin:/opt/cluster/bin:$PATH"' \
    > /etc/profile.d/rakazo-tools.sh
ENV JAVA_HOME=/opt/java/21 \
    NPM_CONFIG_PREFIX=/home/rakazo/.npm-global \
    GRADLE_OPTS="-Dorg.gradle.java.installations.paths=/opt/java/17,/opt/java/21" \
    PATH=/home/rakazo/.npm-global/bin:/opt/node/bin:/opt/java/21/bin:/opt/maven/bin:/opt/gradle/bin:/opt/cluster/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER 1000:1000
