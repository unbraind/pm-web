/** Receipt accounting for unique mutations, independent of HTTP acknowledgement timing. */
export interface CapacityWrite {
  sequence: number;
  itemId: string;
  transport: "http" | "cli";
  committedAt: number | null;
  error: boolean;
}

/** One subscriber's bounded first-receipt and duplicate counters, indexed by write sequence. */
export interface CapacitySubscriber {
  clientId?: string;
  receivedAt: Float64Array;
  counts: Uint32Array;
  disconnected: boolean;
}

/** Millisecond distribution using the nearest-rank convention; empty populations are explicit. */
export function distribution(values: readonly number[]): { samples: number; p50: number | null; p95: number | null; p99: number | null; max: number | null } {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percent: number): number | null => sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)] ?? null;
  return { samples: sorted.length, p50: rank(0.5), p95: rank(0.95), p99: rank(0.99), max: sorted.at(-1) ?? null };
}

/** Account for every committed write at every subscriber, retaining missing sequences. */
export function deliverySummary(writes: readonly CapacityWrite[], subscribers: readonly CapacitySubscriber[]) {
  const pairs: number[] = [];
  const allSubscribers: number[] = [];
  const byTransport: Record<"http" | "cli", number[]> = { http: [], cli: [] };
  const perSubscriber = subscribers.map((subscriber, index) => {
    const missing: number[] = [];
    let duplicates = 0;
    for (const write of writes) {
      if (write.committedAt === null) continue;
      const count = subscriber.counts[write.sequence];
      if (count === 0) missing.push(write.sequence);
      else {
        const latency = subscriber.receivedAt[write.sequence] - write.committedAt;
        if (latency < 0) throw new Error("Receipt predates its committed history timestamp");
        pairs.push(latency);
        byTransport[write.transport].push(latency);
        duplicates += count - 1;
      }
    }
    return { subscriber: index, lost: missing.length, duplicates, missing_sequences: missing, disconnected: subscriber.disconnected };
  });
  for (const write of writes) {
    if (write.committedAt === null || subscribers.some((subscriber) => subscriber.counts[write.sequence] === 0)) continue;
    allSubscribers.push(Math.max(...subscribers.map((subscriber) => subscriber.receivedAt[write.sequence] - write.committedAt!)));
  }
  return {
    latency_ms: distribution(pairs), to_every_subscriber_ms: distribution(allSubscribers),
    http_latency_ms: distribution(byTransport.http), cli_latency_ms: distribution(byTransport.cli),
    lost: perSubscriber.reduce((sum, row) => sum + row.lost, 0),
    duplicates: perSubscriber.reduce((sum, row) => sum + row.duplicates, 0),
    per_subscriber: perSubscriber,
  };
}
