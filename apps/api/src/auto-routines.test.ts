import { describe, expect, it } from "vitest";
import { jenkinsBranchJobName, jenkinsBranchPrompt } from "./auto-routines.js";

describe("branch build watches", () => {
  it("names a branch's job the way Jenkins multibranch projects do", () => {
    expect(jenkinsBranchJobName("feature/kind-test")).toBe("feature%2Fkind-test");
    expect(jenkinsBranchJobName("users/itay/100%-done")).toBe("users%2Fitay%2F100%25-done");
    expect(jenkinsBranchJobName("main")).toBe("main");
  });
  it("asks before fixing", () => {
    const prompt = jenkinsBranchPrompt("repos/app", "feature/x", "team/job/app/job/feature%2Fx");
    expect(prompt).toContain('jenkins_last_completed_build (job "team/job/app/job/feature%2Fx")');
    expect(prompt).toContain('"Fix it" and "Not now"');
  });
});
