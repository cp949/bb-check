import { describe, expect, it } from "vitest";
import { startDeadline, type TimerAdapter } from "../src/cdp.js";

interface PendingTimer {
  readonly id: number;
  readonly delayMs: number;
  readonly callback: () => void;
}

/** 실제 timer 없이 예약/취소를 관찰하고 원하는 시점에 발화시키는 test double. */
class FakeTimers implements TimerAdapter {
  private nextId = 0;
  private readonly timers = new Map<number, PendingTimer>();

  schedule(callback: () => void, delayMs: number): () => void {
    const id = (this.nextId += 1);
    this.timers.set(id, { id, delayMs, callback });
    return (): void => {
      this.timers.delete(id);
    };
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  fire(delayMs: number): number {
    const due = [...this.timers.values()].filter(
      (timer) => timer.delayMs === delayMs,
    );
    for (const timer of due) {
      this.timers.delete(timer.id);
      timer.callback();
    }
    return due.length;
  }
}

describe("startDeadline", () => {
  it("만료 전에는 expired가 false이고 만료 시 등록된 listener를 모두 실행한다", () => {
    const timers = new FakeTimers();
    const deadline = startDeadline(timers, 500);
    const calls: string[] = [];
    deadline.onExpire(() => calls.push("a"));
    deadline.onExpire(() => calls.push("b"));

    expect(deadline.expired()).toBe(false);
    expect(timers.fire(500)).toBe(1);
    expect(deadline.expired()).toBe(true);
    expect(calls).toEqual(["a", "b"]);
  });

  it("이미 만료된 뒤 등록한 listener는 동기 즉시 실행된다", () => {
    const timers = new FakeTimers();
    const deadline = startDeadline(timers, 500);
    timers.fire(500);
    const calls: string[] = [];
    deadline.onExpire(() => calls.push("late"));

    expect(calls).toEqual(["late"]);
  });

  it("onExpire가 돌려준 해제 함수는 만료 전 등록을 취소한다", () => {
    const timers = new FakeTimers();
    const deadline = startDeadline(timers, 500);
    const calls: string[] = [];
    const cancel = deadline.onExpire(() => calls.push("removed"));
    cancel();
    timers.fire(500);

    expect(calls).toEqual([]);
  });

  it("cancel은 timer를 해제하고 이후 어떤 listener도 실행하지 않는다", () => {
    const timers = new FakeTimers();
    const deadline = startDeadline(timers, 500);
    const calls: string[] = [];
    deadline.onExpire(() => calls.push("never"));
    deadline.cancel();

    expect(timers.pendingCount).toBe(0);
    expect(timers.fire(500)).toBe(0);
    expect(calls).toEqual([]);
    expect(deadline.expired()).toBe(false);
  });

  it("한 listener의 throw가 나머지 listener 실행을 막지 않는다", () => {
    const timers = new FakeTimers();
    const deadline = startDeadline(timers, 500);
    const calls: string[] = [];
    deadline.onExpire(() => {
      throw new Error("listener 실패");
    });
    deadline.onExpire(() => calls.push("survivor"));
    timers.fire(500);

    expect(calls).toEqual(["survivor"]);
  });
});
