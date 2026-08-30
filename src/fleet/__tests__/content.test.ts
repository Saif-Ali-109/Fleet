import { describe, expect, it } from "vitest";
import {
	buildContentDoc,
	chunkSection,
	computeDocHash,
	parseMarkdownSource,
	provenanceOf,
	splitSections,
	syncOutcome,
} from "../content.ts";
import { sha256Hex, canonicalizeText } from "../../sor/kernel/hash.ts";

describe("sha256Hex + canonicalizeText locked vectors (mirroring hash.test.ts)", () => {
	it("sha256Hex('{\"a\":\"b\"}') matches locked vector", () => {
		expect(sha256Hex('{"a":"b"}')).toBe(
			"db4a7ecb114bc66c623a06c4ff6fe8daa2f49cc270ebbf7a1f81e22ab061c837",
		);
	});

	it("sha256Hex(canonicalizeText('line1\\nline2')) matches locked vector", () => {
		expect(sha256Hex(canonicalizeText("line1\nline2"))).toBe(
			"683376e290829b482c2655745caffa7a1dccfa10afaa62dac2b42dd6c68d0f83",
		);
	});

	it("canonicalizeText strips BOM, NFC, normalizes EOL, trims", () => {
		expect(canonicalizeText("\uFEFFline1")).toBe("line1");
		expect(canonicalizeText("e\u0301")).toBe("\u00e9");
		expect(canonicalizeText("a\r\nb\rc")).toBe("a\nb\nc");
		expect(canonicalizeText("  a  \nb  \n")).toBe("a\nb");
		expect(canonicalizeText("\n  a\nb  \n")).toBe("a\nb");
	});
});

describe("splitSections — section-aware, code-fence safe", () => {
	it("splits on H2 and H3 headings", () => {
		const text = `# Title

root content

## Section A
content A

### Subsection A1
content A1

## Section B
content B`;

		const sections = splitSections(text);
		expect(sections).toHaveLength(4);
		expect(sections[0]).toEqual({
			heading: "root",
			content: "# Title\n\nroot content\n",
		});
		expect(sections[1]).toEqual({
			heading: "Section A",
			content: "content A\n",
		});
		expect(sections[2]).toEqual({
			heading: "Subsection A1",
			content: "content A1\n",
		});
		expect(sections[3]).toEqual({
			heading: "Section B",
			content: "content B",
		});
	});

	it("preserves code fences — never splits inside them", () => {
		const text = `Root content before heading.

## Section A
\`\`\`js
## fake heading inside fence
\`\`\`
content after`;

		const sections = splitSections(text);
		expect(sections).toHaveLength(2);
		expect(sections[0]!.heading).toBe("root");
		expect(sections[0]!.content).toBe("Root content before heading.\n");
		expect(sections[1]!.heading).toBe("Section A");
		expect(sections[1]!.content).toContain("## fake heading inside fence");
	});

	it("handles tilde fences too", () => {
		const text = `Root content before heading.

## Section A
~~~
### fake
~~~
real content`;

		const sections = splitSections(text);
		expect(sections).toHaveLength(2);
		expect(sections[1]!.content).toContain("### fake");
	});

	it("empty document produces root section", () => {
		const sections = splitSections("");
		expect(sections).toHaveLength(1);
		expect(sections[0]!.heading).toBe("root");
		expect(sections[0]!.content).toBe("");
	});
});

describe("chunkSection — cap/overlap respected, sentence/paragraph breaks", () => {
	it("chunks at 4000 cap with 200 overlap", () => {
		const longText = "a".repeat(5000);
		const chunks = chunkSection("test", longText, 0);

		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c.text.length).toBeLessThanOrEqual(4000);
			expect(c.section).toBe("test");
		}
		// Check overlap: end of chunk 0 should overlap with start of chunk 1
		expect(chunks[0]!.text.slice(-200)).toBe(chunks[1]!.text.slice(0, 200));
	});

	it("prefers sentence breaks (.\n\n) within overlap window", () => {
		const text = "Sentence one.\n\nSentence two.\n\nSentence three.\n\nSentence four.";
		// Force a break point
		const chunks = chunkSection("sec", text.repeat(100), 0);
		expect(chunks.length).toBeGreaterThan(0);
		// Each chunk ends at a sentence boundary when possible
		for (const c of chunks) {
			expect(c.text.trimEnd()).toMatch(/\.$/);
		}
	});

	it("falls back to paragraph breaks (\n\n) when no sentence break in window", () => {
		const text = "Para one\n\nPara two\n\nPara three\n\nPara four";
		const chunks = chunkSection("sec", text.repeat(200), 0);
		for (const c of chunks) {
			expect(c.text.length).toBeLessThanOrEqual(4000);
		}
	});

	it("chunkIndex sequential per document", () => {
		const text = "x".repeat(5000);
		const chunks = chunkSection("sec", text, 5);
		expect(chunks[0]!.chunkIndex).toBe(5);
		expect(chunks[1]!.chunkIndex).toBe(6);
	});
});

describe("parseMarkdownSource — full document parse", () => {
	it("sourceId is stable per path", () => {
		const { doc } = parseMarkdownSource("docs/guide.md", "# Title\n\nContent", "/root");
		expect(doc.sourceId).toBe("fleet|content|md:docs/guide.md");
	});

	it("title from first ATX H1; falls back to document name", () => {
		const { doc: d1 } = parseMarkdownSource("guide.md", "# My Title\n\nBody", "/root");
		expect(d1.metadata.title).toBe("My Title");

		const { doc: d2 } = parseMarkdownSource("guide.md", "No heading\n\nBody", "/root");
		expect(d2.metadata.title).toBeUndefined();
		expect(d2.metadata.document).toBe("guide");
	});

	it("section-aware chunking with section + chunkIndex", () => {
		const text = `# Title

Root section content here.

## Section One
Content for section one. It has multiple sentences. Second sentence.

### Subsection
Sub content here.

## Section Two
Final section content.`;

		const { doc, chunks } = parseMarkdownSource("doc.md", text, "/root");

		expect(doc.sorType).toBe("content");
		expect(doc.namespace).toBe("fleet");
		expect(doc.version).toBe(1);
		expect(doc.status).toBe("active");
		expect(doc.metadata.source).toBe("fleet");
		expect(doc.metadata.document).toBe("doc");

		// root section
		expect(chunks[0]!.section).toBe("root");
		expect(chunks[0]!.chunkIndex).toBe(0);
		// Section One
		const sec1 = chunks.find((c) => c.section === "Section One");
		expect(sec1).toBeDefined();
		if (sec1) expect(sec1.chunkIndex).toBeGreaterThanOrEqual(1);
		// Subsection
		const sub = chunks.find((c) => c.section === "Subsection");
		expect(sub).toBeDefined();
		// Section Two
		const sec2 = chunks.find((c) => c.section === "Section Two");
		expect(sec2).toBeDefined();

		// All chunks have contentHash (chunk-level)
		for (const c of chunks) {
			expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
			expect(c.embedding).toBeNull();
			expect(c.ref.sorType).toBe("content");
			expect(c.ref.sourceId).toBe(doc.sourceId);
			expect(c.ref.version).toBe(doc.version);
			expect(c.ref.hash).toBe(doc.hash);
		}
	});

	it("never splits inside code fences", () => {
		const text = `# Title

## Section
\`\`\`js
function foo() {
  ## not a heading
}
\`\`\`
After fence`;

		const { chunks } = parseMarkdownSource("test.md", text, "/root");
		const secChunk = chunks.find((c) => c.section === "Section");
		expect(secChunk).toBeDefined();
		expect(secChunk!.text).toContain("## not a heading");
	});

	it("doc.hash computed from canonical content via kernel hash.ts", () => {
		const text = "# Title\n\nContent here.";
		const { doc } = parseMarkdownSource("test.md", text, "/root");
		const expected = sha256Hex(canonicalizeText(text));
		expect(doc.hash).toBe(expected);
		expect(doc.hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("buildContentDoc + computeDocHash", () => {
	it("assembles locked struct and computes hash via canonicalizeText", () => {
		const canonical = "canonical content body";
		const doc = buildContentDoc({
			sourceId: "fleet|content|md:test.md",
			version: 3,
			canonicalContent: canonical,
			metadata: { source: "fleet", document: "test", title: "Test" },
			provenance: { acquiredAt: "2024-01-01T00:00:00Z" },
		});

		expect(doc.sorType).toBe("content");
		expect(doc.namespace).toBe("fleet");
		expect(doc.version).toBe(3);
		expect(doc.canonicalContent).toBe(canonical);
		expect(doc.hash).toBe(sha256Hex(canonicalizeText(canonical)));
		expect(doc.status).toBe("active");
	});

	it("computeDocHash uses canonicalizeText on canonicalContent only", () => {
		const doc = {
			sorType: "content" as const,
			sourceId: "id",
			namespace: "fleet" as const,
			version: 1,
			status: "active" as const,
			canonicalContent: "body",
			metadata: { source: "fleet", document: "doc" },
			provenance: {},
		};
		expect(computeDocHash(doc)).toBe(sha256Hex(canonicalizeText("body")));
	});
});

describe("provenanceOf — locked 5-tuple (C3/FR-15)", () => {
	it("returns exact 5 fields with content_hash = doc hash (not chunk hash)", () => {
		const ref = {
			sorType: "content" as const,
			sourceId: "fleet|content|md:doc.md",
			version: 2,
			hash: "abc123",
		};
		const prov = provenanceOf(ref, "fleet", "doc", "Section One");

		expect(prov).toEqual({
			source: "fleet",
			document: "doc",
			section: "Section One",
			version: 2,
			content_hash: "abc123",
		});
		expect(prov.content_hash).toBe(ref.hash);
	});

	it("content_hash is canonical doc hash, never chunk hash", () => {
		const chunkHash = "chunkhash123";
		const docHash = "dochash456";
		const ref = {
			sorType: "content" as const,
			sourceId: "id",
			version: 1,
			hash: docHash,
		};
		const prov = provenanceOf(ref, "src", "doc", "sec");
		expect(prov.content_hash).toBe(docHash);
		expect(prov.content_hash).not.toBe(chunkHash);
	});
});

describe("syncOutcome — idempotent re-sync (FR-13)", () => {
	it("prev === null ⇒ added, version = next.version", () => {
		const next = buildContentDoc({
			sourceId: "id",
			version: 1,
			canonicalContent: "content",
			metadata: { source: "fleet", document: "doc" },
			provenance: {},
		});
		const out = syncOutcome(null, next);
		expect(out).toEqual({ kind: "added", version: 1 });
	});

	it("same canonical hash ⇒ unchanged, NO version bump", () => {
		const prev = buildContentDoc({
			sourceId: "id",
			version: 5,
			canonicalContent: "same content",
			metadata: { source: "fleet", document: "doc" },
			provenance: {},
		});
		const next = buildContentDoc({
			sourceId: "id",
			version: 5,
			canonicalContent: "same content",
			metadata: { source: "fleet", document: "doc" },
			provenance: {},
		});
		expect(prev.hash).toBe(next.hash);

		const out = syncOutcome(prev, next);
		expect(out).toEqual({ kind: "unchanged", version: 5 });
	});

	it("different canonical hash ⇒ updated, version = prev.version + 1", () => {
		const prev = buildContentDoc({
			sourceId: "id",
			version: 3,
			canonicalContent: "old content",
			metadata: { source: "fleet", document: "doc" },
			provenance: {},
		});
		const next = buildContentDoc({
			sourceId: "id",
			version: 3,
			canonicalContent: "new content",
			metadata: { source: "fleet", document: "doc" },
			provenance: {},
		});
		expect(prev.hash).not.toBe(next.hash);

		const out = syncOutcome(prev, next);
		expect(out).toEqual({ kind: "updated", version: 4 });
	});
});