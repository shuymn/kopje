// Global setup of the Workers projects (vitest.config.ts, vitest.streaming.config.ts): a new scope for the plan audit's
// cache (test/sql-depth-setup.ts) on each run and each watch rerun, so a rerun after a change plans afresh.

import { randomUUID } from "node:crypto";

import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    planAuditRun: string;
  }
}

export default function setup(project: TestProject): void {
  project.provide("planAuditRun", randomUUID());
  project.onTestsRerun(() => project.provide("planAuditRun", randomUUID()));
}
