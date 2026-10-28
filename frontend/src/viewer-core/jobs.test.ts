import { describe, expect, it } from "vitest";
import { ago, unattended, type Job } from "../pages/JobsPage";

const job = (o: Partial<Job>): Job => ({ kind: "registration", id: 1, status: "queued", image: 1, target_image: 2, plugin: null, plugin_name: null, progress: null, worker: null, error: null, creator: 1, created_at: "2026-01-01T00:00:00Z", started_at: null, finished_at: null, result: null, ...o });
const now = new Date("2026-01-01T00:01:00Z").getTime();

describe("jobs", () => {
  it("says how long ago in words", () => {
    expect(ago("2026-01-01T00:00:50Z", now)).toBe("just now");
    expect(ago("2026-01-01T00:00:00Z", now)).toBe("1 min ago");
    expect(ago("2025-12-31T21:00:00Z", now)).toBe("3 h ago");
    expect(ago(null, now)).toBe("");
  });
  it("finds the kinds that wait with nobody to do them", () => {
    const w = (kinds: string[]) => [{ name: "w", kinds, seen_seconds_ago: 5 }];
    expect(unattended([job({})], [], now)).toEqual(["registration"]);
    expect(unattended([job({})], w(["plugin"]), now)).toEqual(["registration"]);
    expect(unattended([job({})], w(["registration"]), now)).toEqual([]);
    expect(unattended([job({ created_at: "2026-01-01T00:00:55Z" })], [], now)).toEqual([]); // just queued
    expect(unattended([job({ status: "running" })], [], now)).toEqual([]);
  });
});
