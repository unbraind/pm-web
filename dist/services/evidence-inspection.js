import { evidenceSourceKey as sourceKey, publicEvidenceSource as publicSource, readApprovedEvidence } from './evidence-source.js';
import { createHash } from 'node:crypto';
import { check, criterionFacts, EvidenceError, parseCitation, replay, tokens } from 'pm-evidence';
import { EvidenceInspectionError, parseEvidenceInspection, parseEvidenceInspectionPage } from '../evidence-inspection.js';
/** Bounded fragment display reports every omitted character instead of silently shortening evidence. */
function fragment(text, reason = 'unavailable') {
    return { text: text === undefined ? null : text.slice(0, 512), omittedCharacters: text === undefined ? 0 : Math.max(0, text.length - 512), reason: text === undefined ? reason : null };
}
/** Validate retained bytes through pm-evidence; original exact anchors are checked by their source digest. */
function citedText(citation) {
    if (citation.retained !== undefined) {
        try {
            return replay(citation);
        }
        catch {
            return undefined;
        }
    }
    const quote = citation.descriptor.anchor?.quote;
    return quote !== undefined && createHash('sha256').update(quote).digest('hex') === citation.fragmentDigest ? quote : undefined;
}
/** Inspect a single native item without schema activation, observation writes, git or persistent caches. */
export async function inspectEvidence(host, raw) {
    const input = parseEvidenceInspection(raw);
    try {
        const before = (await host.client.get(input.item, { full: true })).item;
        const allowed = new Set((before.files ?? []).filter(link => link.scope === 'project' && publicSource(link.path)).map(link => sourceKey(link.path)));
        // Share one immutable snapshot across freshness and criterion checks, then discard it.
        const reads = new Map();
        const denied = new Set();
        const adapters = ['file', 'json'].map(provider => ({ provider, async read(source, context) {
                if (!allowed.has(sourceKey(source)) || !publicSource(source))
                    throw new EvidenceError('boundary', 'Source is not allowed', 'Link an allowed project source on this item before inspecting it.');
                const key = sourceKey(source);
                let pending = reads.get(key);
                if (!pending) {
                    pending = readApprovedEvidence(source, context);
                    reads.set(key, pending);
                }
                try {
                    return await pending;
                }
                catch (error) {
                    if (error instanceof EvidenceError && ['boundary', 'unsupported'].includes(error.code))
                        denied.add(key);
                    throw error;
                }
            } }));
        const options = { client: host.client, workspace: host.workspace, root: host.root, adapters, record: false, diff: true, budget: 1_000_000, maxBytes: 262144, timeoutMs: 3000, signal: AbortSignal.timeout(8000) };
        const checked = await check([before.id], options);
        const facts = await criterionFacts([before.id], { ...options, diff: false });
        if (checked.receipt.omitted || facts.receipt.omitted)
            throw new EvidenceInspectionError('unavailable', 'Narrow this item evidence and criterion bindings before inspection.', 503);
        if (checked.receipt.verification?.foreignItems)
            checked.rows.push({ item: before.id, citation: 'foreign-envelope', resolution: 'inaccessible', currentResolution: 'inaccessible', freshness: 'unknown', oldDigest: '', currentDigest: null, sourceChanged: null, currentRevision: null, replay: false, code: 'schema', remedy: 'Foreign evidence envelope was preserved. Ask its owner to restore supported pm-evidence records.' });
        const citations = new Map();
        // The producer owns per-record validation; a bad citation never suppresses valid peers.
        try {
            const envelope = JSON.parse(String(before.evidence_state));
            if (Array.isArray(envelope.citations))
                for (const value of envelope.citations) {
                    try {
                        const citation = parseCitation(value, before.id);
                        if (!citations.has(citation.id))
                            citations.set(citation.id, citation);
                    }
                    catch { /* check reports the isolated invalid record */ }
                }
        }
        catch { /* check reports a foreign or malformed envelope */ }
        const selected = checked.rows.slice(input.offset, input.offset + input.limit).map(row => {
            const citation = row.code === 'schema' ? undefined : citations.get(row.citation);
            const permitted = citation !== undefined && !denied.has(sourceKey(citation.descriptor.source)) && allowed.has(sourceKey(citation.descriptor.source)) && publicSource(citation.descriptor.source) && ['file', 'json'].includes(citation.descriptor.provider);
            const original = permitted ? citedText(citation) : undefined;
            return {
                citation: row.citation, source: permitted ? citation.descriptor.source : null, selector: permitted ? citation.descriptor.selector : null,
                resolution: row.resolution, freshness: row.freshness,
                cited: fragment(original, permitted ? 'not-retained' : 'not-allowed'),
                current: fragment(permitted ? row.freshness === 'current' ? original : row.diff?.current.join('\n') : undefined, permitted ? 'unavailable' : 'not-allowed'),
                bindings: permitted ? facts.rows.filter(fact => fact.citation === row.citation) : [], code: row.code ?? null,
                remedy: row.remedy ?? null,
            };
        });
        const after = (await host.client.get(before.id, { full: true })).item;
        if (JSON.stringify(after) !== JSON.stringify(before))
            throw new EvidenceInspectionError('conflict', 'The item changed during inspection. Refresh against its current revision.', 409);
        const gaps = facts.rows.filter(fact => fact.citation === null && fact.support !== 'unbound');
        /** Account for the complete larger JSON/TOON result, including omission and token receipts. */
        const page = (rows) => {
            const end = input.offset + rows.length;
            const result = { protocol: 'pm-web-evidence/v1', item: before.id, truthAssessed: false, mutation: 'unsupported', criterionGaps: gaps.slice(0, 20), omittedCriterionGaps: Math.max(0, gaps.length - 20), rows, total: checked.rows.length, offset: input.offset, nextOffset: end < checked.rows.length ? end : null, omitted: checked.rows.length - rows.length, estimatedTokens: 0, sourceReads: reads.size, remedy: 'Refresh to recheck sources. Use pm-evidence with an authorized editor for schema setup, citations or reviews. Freshness does not prove completion.' };
            for (let estimate = tokens(result); estimate !== result.estimatedTokens; estimate = tokens(result))
                result.estimatedTokens = estimate;
            return result;
        };
        let result = page(selected);
        while (result.estimatedTokens > input.budget && selected.length) {
            selected.pop();
            result = page(selected);
        }
        if (result.estimatedTokens > input.budget || (!selected.length && input.offset < checked.rows.length))
            throw new EvidenceInspectionError('budget', 'Increase budget or inspect an item with smaller criterion bindings.', 400);
        return parseEvidenceInspectionPage(result);
    }
    catch (error) {
        if (error instanceof EvidenceInspectionError)
            throw error;
        throw new EvidenceInspectionError('unavailable', 'Check item identity, tracker health and pm-evidence support, then refresh. Inspection never registers schema fields.', 503);
    }
}
//# sourceMappingURL=evidence-inspection.js.map