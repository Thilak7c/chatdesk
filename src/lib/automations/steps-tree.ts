// src/lib/automations/steps-tree.ts

import { db } from "@/db";
import { automationSteps } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

export interface BuilderStepInput {
  id?: string;
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes?: BuilderStepInput[]; no?: BuilderStepInput[] };
  branch?: "yes" | "no" | null;
  parent_index?: number | null;
}

interface InsertRow {
  id: string;
  automationId: string;
  parentStepId: string | null;
  branch: "yes" | "no" | null;
  stepType: string;
  stepConfig: Record<string, unknown>;
  position: number;
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

export async function replaceSteps(
  automationId: string,
  input: BuilderStepInput[],
): Promise<string | null> {
  try {
    await db.delete(automationSteps).where(eq(automationSteps.automationId, automationId));
  } catch (err) {
    return err instanceof Error ? err.message : "Failed to delete existing steps";
  }
  return insertSteps(automationId, input);
}

export async function insertSteps(
  automationId: string,
  input: BuilderStepInput[],
): Promise<string | null> {
  if (!input || input.length === 0) return null;

  const looksFlat = input.some(
    (s) => s.branch !== undefined || s.parent_index !== undefined,
  );
  const tree = looksFlat ? seedsToTree(input) : input;

  const rows: InsertRow[] = [];
  function walk(
    steps: BuilderStepInput[],
    parentId: string | null,
    branch: "yes" | "no" | null,
  ) {
    steps.forEach((s, idx) => {
      const id = s.id ?? uid();
      rows.push({
        id,
        automationId,
        parentStepId: parentId,
        branch,
        stepType: s.step_type,
        stepConfig: s.step_config ?? {},
        position: idx,
      });
      if (s.step_type === "condition" && s.branches) {
        if (s.branches.yes) walk(s.branches.yes, id, "yes");
        if (s.branches.no) walk(s.branches.no, id, "no");
      }
    });
  }
  walk(tree, null, null);

  if (rows.length === 0) return null;
  try {
    await db.insert(automationSteps).values(rows);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Failed to insert steps";
  }
}

function seedsToTree(seeds: BuilderStepInput[]): BuilderStepInput[] {
  const nodes: BuilderStepInput[] = seeds.map((s) => ({
    ...s,
    branches: { yes: [], no: [] },
  }));
  const roots: BuilderStepInput[] = [];
  nodes.forEach((n, i) => {
    const seed = seeds[i];
    if (seed.parent_index == null) {
      roots.push(n);
    } else {
      const parent = nodes[seed.parent_index];
      parent.branches = parent.branches ?? { yes: [], no: [] };
      const bucket = (seed.branch ?? "yes") as "yes" | "no";
      (parent.branches[bucket] ??= []).push(n);
    }
  });
  return roots;
}

export interface BuilderStepNode extends BuilderStepInput {
  id: string;
  branches: { yes: BuilderStepNode[]; no: BuilderStepNode[] };
}

export async function loadStepsTree(automationId: string): Promise<BuilderStepNode[]> {
  const rows = await db
    .select()
    .from(automationSteps)
    .where(eq(automationSteps.automationId, automationId))
    .orderBy(asc(automationSteps.position));

  const byId = new Map<string, BuilderStepNode>();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      step_type: row.stepType,
      step_config: (row.stepConfig as Record<string, unknown>) ?? {},
      branches: { yes: [], no: [] },
    });
  }

  const roots: BuilderStepNode[] = [];
  for (const row of rows) {
    const node = byId.get(row.id)!;
    if (row.parentStepId) {
      const parent = byId.get(row.parentStepId);
      if (parent) {
        const bucket = (row.branch ?? "yes") as "yes" | "no";
        parent.branches[bucket].push(node);
      }
    } else {
      roots.push(node);
    }
  }
  return roots;
}