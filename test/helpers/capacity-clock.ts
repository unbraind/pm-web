/** Pin a separate real writer's clock to reproduce an older timestamp becoming visible after a cursor advances. */
const originalDate = Date;
const timestamp = Number(process.env.CAPACITY_CLOCK_TIMESTAMP);
if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("A synthetic history timestamp is required");
globalThis.Date = new Proxy(originalDate, {
  construct(target, args) {
    return Reflect.construct(target, args.length === 0 ? [timestamp] : args);
  },
  get(target, key) {
    if (key === "now") return () => timestamp;
    return Reflect.get(target, key);
  },
});
