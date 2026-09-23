export async function withDeadline<T>(
  operation: () => Promise<T>,
  abort: (error: Error) => void,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      reject(error);
      abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), expired]);
  } finally {
    clearTimeout(timer!);
  }
}
