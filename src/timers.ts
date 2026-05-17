/**
 * Abort-aware sleep.
 *
 * Important: remove the abort listener on the normal timeout path. The gateway
 * pullLoop calls this every second with the same AbortSignal; without cleanup,
 * each tick leaves one listener behind until process shutdown.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    const onAbort = () => finish();

    timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
