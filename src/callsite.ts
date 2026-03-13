// Extract the caller's file + line number from the stack trace
// Used for auto-tagging when no manual tag is provided

export function getCallSite(): string | null {
  const err = new Error();
  const stack = err.stack;
  if (!stack) return null;

  const lines = stack.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip the Error line itself
    if (trimmed.startsWith("Error")) continue;

    // Skip costly SDK internals by matching on our known file names
    if (
      trimmed.includes("node_modules/costly/") ||
      trimmed.includes("costlyWrappedMethod") ||
      trimmed.includes("wrapMethod") ||
      trimmed.includes("wrapClient") ||
      trimmed.includes("wrapStream") ||
      trimmed.includes("callsite.") ||
      trimmed.includes("batcher.") ||
      trimmed.includes("LogBatcher")
    ) {
      continue;
    }

    // Extract file:line from the stack frame
    const match = trimmed.match(/\((.+):(\d+):\d+\)/) ||
      trimmed.match(/at (.+):(\d+):\d+/);

    if (match) {
      const file = match[1].replace(/^.*[/\\]/, ""); // basename only
      const line = match[2];
      return `${file}:${line}`;
    }
  }

  return null;
}
