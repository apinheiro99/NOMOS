const ENDPOINTS: Record<string, string> = {
  userstory: "userstories",
  task: "tasks",
  epic: "epics",
  issue: "issues",
  wiki: "wiki",
};

interface CommentClient {
  get(path: string): Promise<unknown>;
  patch(path: string, body?: unknown): Promise<unknown>;
}

export const AUTHOR_MAX = 60;

// The author is its own required field; it is appended as the last line (`-- <author>`), so every comment is signed.
// Free text (the shared credentials cannot prove identity): one non-empty line, bounded. Not added twice.
export function signComment(comment: string, author: string): string {
  const a = author.trim();
  if (!a || /[\r\n]/.test(a) || a.length > AUTHOR_MAX) {
    throw new Error(`author is required: one line, 1-${AUTHOR_MAX} characters (e.g. "Andre", "GPT (GPT-6)", "Claude (Sonnet 5.5)")`);
  }
  const sig = `-- ${a}`;
  const body = comment.trimEnd();
  const last = body.split(/\r?\n/).at(-1)?.trim();
  return last === sig ? body : `${body}\n\n${sig}`;
}

// Taiga adds a comment through a PATCH of the entity; send the entity's current version.
export async function postComment(
  client: CommentClient,
  entityType: string,
  id: number,
  comment: string,
  author: string,
): Promise<unknown> {
  const path = `/${ENDPOINTS[entityType]}/${id}`;
  const current = (await client.get(path)) as { version: number };
  return client.patch(path, { comment: signComment(comment, author), version: current.version });
}

// Governed workflow artifacts carry their Author in the header and have no trailing signature line.
// `version` is the state the caller validated: Taiga refuses the write when the card has moved since. Without it the current version is read (free-standing comments).
export async function postUnsignedComment(client: CommentClient, entityType: string, id: number, comment: string, version?: number): Promise<unknown> {
  const path = `/${ENDPOINTS[entityType]}/${id}`;
  const v = version ?? ((await client.get(path)) as { version: number }).version;
  return client.patch(path, { comment: comment.trimEnd(), version: v });
}
