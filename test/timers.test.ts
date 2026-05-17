import { describe, expect, it, vi } from "vitest";
import { sleep } from "../src/timers.js";

describe("sleep", () => {
  it("removes abort listener after normal timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const promise = sleep(1_000, controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls[0][0]).toBe("abort");
    expect(removeSpy.mock.calls[0][1]).toBe(addSpy.mock.calls[0][1]);

    vi.useRealTimers();
  });

  it("resolves and removes listener when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const promise = sleep(60_000, controller.signal);
    controller.abort();
    await promise;

    expect(removeSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
