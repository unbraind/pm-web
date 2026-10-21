/** Bound concurrent join queries and their waiting sockets independently of stream lifetime. */
export function createSSEAdmission(concurrency, maxPending) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxPending) || maxPending < 1)
        throw new Error("SSE admission bounds must be positive integers");
    let active = 0;
    const pending = new Set();
    /** FIFO admission leaves database capacity for readiness and established subscribers. */
    function drain() {
        for (;;) {
            if (active >= concurrency || pending.size === 0)
                return;
            const start = pending.values().next().value;
            pending.delete(start);
            start();
        }
    }
    /** A queued disconnect cancels admission; an admitted request releases after its initial checks. */
    return (res) => {
        if (res.destroyed || res.writableEnded)
            return Promise.resolve(null);
        if (active >= concurrency && pending.size >= maxPending) {
            res.setHeader("Retry-After", "1");
            res.status(503).json({ error: "Real-time join queue is full; retry shortly" });
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            /** Remove cancellation listeners before the ordinary SSE lifecycle takes ownership. */
            const start = () => {
                res.off("close", cancel);
                if (res.destroyed || res.writableEnded) {
                    resolve(null);
                    return;
                }
                active++;
                let released = false;
                resolve(() => {
                    if (released)
                        return;
                    released = true;
                    active--;
                    drain();
                });
            };
            /** Canceled sockets retain no callback or admission slot. */
            const cancel = () => { pending.delete(start); resolve(null); };
            if (active < concurrency)
                start();
            else {
                pending.add(start);
                res.once("close", cancel);
            }
        });
    };
}
//# sourceMappingURL=sse-admission.js.map