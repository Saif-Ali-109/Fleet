// Fleet Content SoR — parse, chunking, provenance, idempotent sync (pure functions, no I/O).

import { canonicalizeText, sha256Hex } from "../sor/kernel/hash.ts";

export interface ContentDoc {
	sorType: "content";
	sourceId: string;
	namespace: "fleet";
	version: number;
	hash: string;
	status: "active" | "invalid" | "superseded";
	canonicalContent: string;
	metadata: {
		title?: string;
		source: string;
		document: string;
		license?: string;
	};
	provenance: {
		externalRef?: string;
		acquiredAt?: string;
		sourceHash?: string;
	};
}

export interface ContentChunk {
	docId: string;
	version: number;
	section: string;
	chunkIndex: number;
	text: string;
	contentHash: string;
	embedding: number[] | null;
	ref: { sorType: "content"; sourceId: string; version: number; hash: string };
}

export type SyncKind = "added" | "updated" | "removed" | "unchanged";

export interface SyncOutcome {
	kind: SyncKind;
	version: number;
}

const CHUNK_CAP = 4000;
const CHUNK_OVERLAP = 200;

export function splitSections(
	text: string,
): Array<{ heading: string; content: string }> {
	const lines = text.split("\n");
	const sections: Array<{ heading: string; content: string }> = [];
	let currentHeading = "root";
	let currentContent: string[] = [];
	let inCodeFence = false;
	let fenceMarker = "";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		if (!inCodeFence && (line.startsWith("```") || line.startsWith("~~~"))) {
			inCodeFence = true;
			fenceMarker = line.slice(0, 3);
		} else if (inCodeFence && line.startsWith(fenceMarker)) {
			inCodeFence = false;
			fenceMarker = "";
		}

		const h2Match = line.match(/^##\s+(.+)$/);
		const h3Match = line.match(/^###\s+(.+)$/);

		if (!inCodeFence && (h2Match || h3Match)) {
			if (currentContent.length > 0 || sections.length > 0) {
				sections.push({
					heading: currentHeading,
					content: currentContent.join("\n"),
				});
			}
			const match = h2Match ?? h3Match;
			if (match) currentHeading = match[1]!.trim();
			currentContent = [];
		} else {
			currentContent.push(line);
		}
	}

	if (currentContent.length > 0 || sections.length === 0) {
		sections.push({
			heading: currentHeading,
			content: currentContent.join("\n"),
		});
	}

	return sections;
}

export function chunkSection(
	section: string,
	text: string,
	startIndex: number,
): ContentChunk[] {
	const chunks: ContentChunk[] = [];
	let chunkIndex = startIndex;
	let pos = 0;
	const len = text.length;

	while (pos < len) {
		const end = Math.min(pos + CHUNK_CAP, len);
		let chunkText = text.slice(pos, end);

		if (end < len) {
			let breakPos = -1;
			const searchStart = Math.max(0, chunkText.length - CHUNK_OVERLAP);
			const periodBreak = chunkText.lastIndexOf(".\n\n", chunkText.length - 1);
			const paraBreak = chunkText.lastIndexOf("\n\n", chunkText.length - 1);

			if (periodBreak >= searchStart) {
				breakPos = periodBreak + 3;
			} else if (paraBreak >= searchStart) {
				breakPos = paraBreak + 2;
			}

			if (breakPos > 0 && breakPos < chunkText.length) {
				chunkText = chunkText.slice(0, breakPos);
			}
		}

		const trimmedChunk = chunkText.trimEnd();
		if (trimmedChunk.length > 0) {
			chunks.push({
				docId: "",
				version: 0,
				section,
				chunkIndex,
				text: trimmedChunk,
				contentHash: sha256Hex(trimmedChunk),
				embedding: null,
				ref: { sorType: "content", sourceId: "", version: 0, hash: "" },
			});
			chunkIndex++;
		}

		if (end >= len) break;
		pos = end - CHUNK_OVERLAP;
		if (pos < 0) pos = 0;
	}

	return chunks;
}

export function parseMarkdownSource(
	relPath: string,
	text: string,
	_rootPath: string,
): { doc: ContentDoc; chunks: ContentChunk[] } {
	const canonicalContent = canonicalizeText(text);
	const sourceId = `fleet|content|md:${relPath}`;
	const docName = relPath.split("/").pop()?.replace(/\.md$/i, "") ?? relPath;

	const h1Match = text.match(/^#\s+(.+)$/m);
	const title = h1Match?.[1]?.trim();

	const sections = splitSections(text);
	const allChunks: ContentChunk[] = [];
	let chunkIndex = 0;

	for (const sec of sections) {
		const secChunks = chunkSection(sec.heading, sec.content, chunkIndex);
		allChunks.push(...secChunks);
		chunkIndex += secChunks.length;
	}

	const metadata = {
		title,
		source: "fleet",
		document: docName,
		license: undefined as string | undefined,
	};

	const provenance = {
		externalRef: undefined as string | undefined,
		acquiredAt: undefined as string | undefined,
		sourceHash: undefined as string | undefined,
	};

	const doc = buildContentDoc({
		sourceId,
		version: 1,
		canonicalContent,
		metadata,
		provenance,
	});

	const finalChunks = allChunks.map((c, idx) => ({
		...c,
		docId: doc.sourceId,
		version: doc.version,
		chunkIndex: idx,
		ref: {
			sorType: "content" as const,
			sourceId: doc.sourceId,
			version: doc.version,
			hash: doc.hash,
		},
	}));

	return { doc, chunks: finalChunks };
}

export function buildContentDoc(input: {
	sourceId: string;
	version: number;
	canonicalContent: string;
	metadata: ContentDoc["metadata"];
	provenance: ContentDoc["provenance"];
}): ContentDoc {
	const hash = computeDocHash({
		sorType: "content",
		sourceId: input.sourceId,
		namespace: "fleet",
		version: input.version,
		status: "active",
		canonicalContent: input.canonicalContent,
		metadata: input.metadata,
		provenance: input.provenance,
	});

	return {
		sorType: "content",
		sourceId: input.sourceId,
		namespace: "fleet",
		version: input.version,
		hash,
		status: "active",
		canonicalContent: input.canonicalContent,
		metadata: input.metadata,
		provenance: input.provenance,
	};
}

export function computeDocHash(doc: Omit<ContentDoc, "hash">): string {
	return sha256Hex(canonicalizeText(doc.canonicalContent));
}

export function provenanceOf(
	ref: { sorType: "content"; sourceId: string; version: number; hash: string },
	source: string,
	document: string,
	section: string,
): {
	source: string;
	document: string;
	section: string;
	version: number;
	content_hash: string;
} {
	return {
		source,
		document,
		section,
		version: ref.version,
		content_hash: ref.hash,
	};
}

export function syncOutcome(
	prev: ContentDoc | null,
	next: ContentDoc,
): SyncOutcome {
	if (prev === null) {
		return { kind: "added", version: next.version };
	}
	if (prev.hash === next.hash) {
		return { kind: "unchanged", version: prev.version };
	}
	return { kind: "updated", version: prev.version + 1 };
}
