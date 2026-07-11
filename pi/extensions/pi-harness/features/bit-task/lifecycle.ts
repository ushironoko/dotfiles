export const buildTaskMarker = (
  branch: string,
  seq: number,
  taskId: string,
): string => `[task:${branch}#${seq}:${taskId}]`;

export const matchesTaskMarker = (
  title: string,
  branch: string,
  taskId: string,
): boolean => {
  const sequencePrefix = `[task:${branch}#`;
  const markerStart = title.indexOf(sequencePrefix);
  if (markerStart !== -1) {
    const tokenStart = markerStart + sequencePrefix.length;
    const markerEnd = title.indexOf("]", tokenStart);
    if (markerEnd !== -1) {
      const token = title.slice(tokenStart, markerEnd);
      const lastColon = token.lastIndexOf(":");
      if (lastColon > 0 && token.slice(lastColon + 1) === taskId) return true;
    }
  }

  return title.includes(`[task:${branch}:${taskId}]`);
};

export const buildWorktreeCreatePayload = (name: string): string =>
  JSON.stringify({ name });

export const buildWorktreeRemovePayload = (canonicalPath: string): string =>
  JSON.stringify({ confirmed: true, worktree_path: canonicalPath });

export const buildTaskCompletedArgs = (
  taskId: string,
  subject?: string,
): string[] => (subject === undefined ? [taskId] : [taskId, subject]);
