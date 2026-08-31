import { getClientForProvider, getProviderDef, getFleetProviders, providersWithKeys, type ProviderName } from "../../providers/registry.ts";

interface EmbedJob {
	type: "embed";
	texts: string[];
	provider?: string;
	model?: string;
}

interface ShutdownJob {
	type: "shutdown";
}

type Job = EmbedJob | ShutdownJob;

interface EmbedResult {
	type: "embed_result";
	vectors: number[][] | null;
	error?: string;
}

const DEFAULT_BATCH_SIZE = 32;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 200;
// Locked embedding dimension (Gemini text-embedding-004): migration 015 column is vector(768).
const EMBEDDING_DIM = 768;

function getBatchSize(): number {
	const raw = process.env.CONTENT_EMBED_BATCH?.trim();
	if (!raw) return DEFAULT_BATCH_SIZE;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BATCH_SIZE;
	return parsed;
}

function resolveProviderModel(jobProvider?: string, jobModel?: string): { provider: ProviderName; model: string } | null {
	let provider: ProviderName;
	if (jobProvider) {
		const def = getProviderDef(jobProvider as ProviderName);
		if (!def) return null;
		provider = jobProvider as ProviderName;
	} else {
		// Standard: prefer Gemini (text-embedding-004, 768-dim) when no explicit provider.
		const candidates = providersWithKeys(getFleetProviders());
		if (candidates.length === 0) return null;
		provider = (candidates.find((p) => p === "gemini") ?? candidates[0]) as ProviderName;
	}

	const model = jobModel ?? "text-embedding-004";
	return { provider, model };
}

async function embedWithRetry(client: ReturnType<typeof getClientForProvider>, texts: string[], model: string): Promise<number[][] | null> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await client.embeddings.create({
				input: texts,
				model,
			});
			return response.data.map((d) => d.embedding);
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < MAX_RETRIES) {
				await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
			}
		}
	}
	return null;
}

async function processEmbedJob(job: EmbedJob): Promise<EmbedResult> {
	const resolved = resolveProviderModel(job.provider, job.model);
	if (!resolved) {
		return { type: "embed_result", vectors: null, error: "no provider configured or provider has no key" };
	}

	const { provider, model } = resolved;
	const client = getClientForProvider(provider);

	const batchSize = getBatchSize();
	const allVectors: number[][] = [];

	for (let i = 0; i < job.texts.length; i += batchSize) {
		const batch = job.texts.slice(i, i + batchSize);
		const vectors = await embedWithRetry(client, batch, model);
		if (vectors === null) {
			return { type: "embed_result", vectors: null, error: `embedding failed for provider ${provider}, model ${model}` };
		}
		// Fail closed on a non-768-dim vector: column is vector(768); a mismatched
		// dimension is a write failure (locked standard, decision D2/decision-log #39).
		if (vectors.some((v) => v.length !== EMBEDDING_DIM)) {
			return {
				type: "embed_result",
				vectors: null,
				error: `embedding produced non-${EMBEDDING_DIM}-dim vectors for provider ${provider}, model ${model} (expected ${EMBEDDING_DIM})`,
			};
		}
		allVectors.push(...vectors);
	}

	return { type: "embed_result", vectors: allVectors };
}

async function main(): Promise<void> {
	let shuttingDown = false;

	// Keep the process alive for IPC messages
	process.stdin.resume();

	// Signal ready to parent
	process.send?.({ type: "ready" });

	process.on("message", async (message: unknown) => {
		if (shuttingDown) return;
		if (!message || typeof message !== "object") return;

		const job = message as Job;

		if (job.type === "shutdown") {
			shuttingDown = true;
			process.send?.({ type: "embed_result", vectors: [], error: undefined });
			process.exit(0);
			return;
		}

		if (job.type === "embed") {
			const result = await processEmbedJob(job);
			try {
				process.send?.(result);
			} catch {
				// parent disconnected
				process.exit(0);
			}
			return;
		}
	});

	process.on("disconnect", () => {
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		process.exit(0);
	});

	process.on("SIGINT", () => {
		process.exit(0);
	});
}

const isEntry = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;

if (isEntry) {
	main().catch((err) => {
		console.error(`[embed] fatal: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}