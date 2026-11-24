import type { TaigaClient } from "../client.js";

// Small, separate precondition rules for governed mutations. Each takes fresh Taiga facts and answers null (fine) or the reason; none writes,
// and none lives inside the write boundary.

// A governed User Story cannot enter In Progress without at least one child Task: there would be nothing to execute or validate.
export const storyHasChildTask = (client: TaigaClient, storyId: number) => async (): Promise<string | null> => {
  const tasks = (await client.getAll("/tasks", { user_story: storyId })) as unknown[];
  return tasks.length > 0 ? null : "a User Story cannot enter In Progress without at least one child Task: create its Tasks first";
};
