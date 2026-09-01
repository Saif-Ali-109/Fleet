import type { Pool } from "pg";
import type { RulePredicate } from "../sor/kernel/types.ts";
import {
	emitContentAccessAggregate,
	retrieveKnowledge as _retrieveKnowledge,
} from "./contentRetrieval.ts";
import type {
	ContentAccessAggregateParams,
	RetrievalResult,
} from "./contentRetrieval.ts";
import { emitContentSyncNonFatal } from "./contentStore.ts";
import type { ContentSyncPayload } from "./contentStore.ts";
import { getContext as _getContext } from "./contextRetrieval.ts";
import type { ContextCategory, ContextReadResult } from "./context.ts";
import { emitContextUpdateNonFatal } from "./contextStore.ts";
import type { ContextUpdatePayload } from "./contextStore.ts";
import {
	evaluateToolCall as _evaluateToolCall,
	type EffectiveToolSet,
	type PolicyDecision,
} from "./policyEval.ts";
import { emitPolicySync } from "../db/audit.ts";
import type { PolicySyncEvent } from "../db/audit.ts";

export type { PolicyDecision, EffectiveToolSet };

export interface SorRetrieveKnowledgeParams {
	query: string;
	source?: string;
	limit?: number;
	queryEmbedding?: number[];
}

export interface SorRetrieveContextParams {
	sourceId?: string;
	category: ContextCategory;
	version?: number;
}

export interface SorEvaluatePolicyParams {
	toolName: string;
	input: unknown;
	effective: EffectiveToolSet;
	rules: Record<string, RulePredicate[]>;
}

export type ProvenanceRecord =
	| { topic: "content-access"; payload: ContentAccessAggregateParams }
	| { topic: "content-sync"; payload: ContentSyncPayload }
	| { topic: "context-update"; payload: ContextUpdatePayload }
	| { topic: "policy-sync"; payload: PolicySyncEvent };

export async function retrieveKnowledge(
	pool: Pool,
	params: SorRetrieveKnowledgeParams,
): Promise<RetrievalResult> {
	return _retrieveKnowledge(pool, params);
}

export async function retrieveContext(
	pool: Pool,
	params: SorRetrieveContextParams,
): Promise<ContextReadResult> {
	return _getContext(pool, params);
}

export function evaluatePolicy(params: SorEvaluatePolicyParams): PolicyDecision {
	return _evaluateToolCall(params.toolName, params.input, params.effective, params.rules);
}

export async function recordProvenance(
	pool: Pool,
	record: ProvenanceRecord,
): Promise<void> {
	try {
		switch (record.topic) {
			case "content-access":
				emitContentAccessAggregate(pool, record.payload);
				break;
			case "content-sync":
				await emitContentSyncNonFatal(pool, record.payload);
				break;
			case "context-update":
				await emitContextUpdateNonFatal(pool, record.payload);
				break;
			case "policy-sync":
				await emitPolicySync(pool, record.payload);
				break;
		}
	} catch (err) {
		console.warn(
			`[sorClient] recordProvenance (${record.topic}) failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export interface SorClient {
	retrieveKnowledge(pool: Pool, params: SorRetrieveKnowledgeParams): Promise<RetrievalResult>;
	retrieveContext(pool: Pool, params: SorRetrieveContextParams): Promise<ContextReadResult>;
	evaluatePolicy(params: SorEvaluatePolicyParams): PolicyDecision;
	recordProvenance(pool: Pool, record: ProvenanceRecord): Promise<void>;
}

export function buildSorClient(_pool: Pool): SorClient {
	return {
		retrieveKnowledge: (pool, params) => retrieveKnowledge(pool, params),
		retrieveContext: (pool, params) => retrieveContext(pool, params),
		evaluatePolicy: (params) => evaluatePolicy(params),
		recordProvenance: (pool, record) => recordProvenance(pool, record),
	};
}
