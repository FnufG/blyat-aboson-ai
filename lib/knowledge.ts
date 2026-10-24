import type { KnowledgeEntry } from "./types";

export const MAX_KNOWLEDGE_ENTRIES = 100;
export const MAX_DOCUMENT_LENGTH = 180_000;

/** Returns a user-facing error; never trusts local storage or API input. */
export function validateKnowledge(entries: unknown): string | null {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "Add at least one question and answer.";
  }
  if (entries.length > MAX_KNOWLEDGE_ENTRIES) {
    return "The knowledge base can contain up to 100 entries.";
  }
  const ids = new Set<string>();
  let documentLength = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return "Invalid knowledge base entry.";
    }
    const { id, title, content } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
      return "Each entry must have a valid identifier.";
    }
    if (ids.has(id)) return "Entry identifiers must be unique.";
    ids.add(id);
    if (typeof title !== "string" || !title.trim()) {
      return "Each entry must have a question or title.";
    }
    if (title.length > 200) return "Entry titles must not exceed 200 characters.";
    if (/[\r\n]/.test(title)) return "Entry titles must fit on one line.";
    if (typeof content !== "string" || !content.trim()) {
      return "Each entry must have a nonempty answer.";
    }
    if (content.length > 4_000) return "Answers must not exceed 4,000 characters. Split longer answers into multiple entries.";
    if (/[\u0000]/.test(title + content)) return "Use a text document without binary data.";
    documentLength += title.length + content.length + 7;
  }
  if (documentLength > MAX_DOCUMENT_LENGTH) {
    return "The knowledge base must not exceed 180,000 characters.";
  }
  return null;
}

function requireValid(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const error = validateKnowledge(entries);
  if (error) throw new Error(error);
  return entries;
}

/** Markdown uses `## Question` headings. Plain text uses blank-line-separated blocks. */
export function parseKnowledge(text: string): KnowledgeEntry[] {
  if (typeof text !== "string") throw new Error("Upload a .txt or .md text file.");
  if (text.length > MAX_DOCUMENT_LENGTH) {
    throw new Error("Documents must not exceed 180,000 characters.");
  }
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error("The document is empty. Add questions and answers.");
  if (normalized.includes("\u0000")) throw new Error("Use a text document without binary data.");

  const headings = [...normalized.matchAll(/^##(?:[\t ]+(.*))?$/gm)];
  const entries: KnowledgeEntry[] = [];
  const addEntry = (title: string, content: string) => {
    entries.push({ id: `faq-${entries.length + 1}`, title: title.trim(), content: content.trim() });
  };
  if (headings.length) {
    const prefix = normalized.slice(0, headings[0].index).trim();
    // Preserve introductions as a searchable source instead of silently dropping them.
    if (prefix) addEntry("General information", prefix);
    headings.forEach((match, index) => {
      const start = match.index! + match[0].length;
      const end = index + 1 < headings.length ? headings[index + 1].index! : normalized.length;
      addEntry(match[1] ?? "", normalized.slice(start, end));
    });
  } else {
    const blocks = normalized.split(/\n[\t ]*\n+/).filter((block) => block.trim());
    for (const [index, block] of blocks.entries()) {
      const lines = block.trim().split("\n");
      if (lines.length > 1) {
        addEntry(lines[0], lines.slice(1).join("\n"));
      } else {
        addEntry(`Section ${index + 1}`, block);
      }
    }
  }
  return requireValid(entries);
}

export function serializeKnowledge(entries: KnowledgeEntry[]): string {
  requireValid(entries);
  return entries.map(({ title, content }) => `## ${title.trim()}\n\n${content.trim()}`).join("\n\n") + "\n";
}

// Fingerprints remove only unchanged records seeded by the earlier prototype.
// Uploaded or edited company information is retained during the v1 migration.
const LEGACY_DEMO_SIGNATURES = new Set([
  "1c5f6f8e6368bb063b4d0a6ba951019b166d9c871696143c462db1b6500572ef",
  "ebabf837a666b8d2c5e2a1a2af2f6c1eea7800c2bb7cbb149739fa2662ac5d66",
  "ad6ab7a670ff745e305b42f60029de6866aa3e87d4bb7f0a2f188a147f7c86c9",
  "efd9f9be74c4bb4b0f8f4e53790a7b2dd5a95d0e7afbc8478bc22a62a62ed37d",
  "2eda3281dc8c8085c306b595ba717909d6c03ad730c8bcc3cbd87f428549f9a8",
  "f3a4c2418e0940d35eed9bad633132da8e40987992a5bfc2d712d0cf5a0b1d62",
  "1b64086381ddd0544372557618c43203f3c0ad85c995c8e7ad80781a6f788ceb",
  "04b7db481bd415e2f03a51adb707c48c127f8bf0939abebab557ac7ba71214bb",
  "7288dab9d66e8821bed17edc8b6df4773cb56703bb8c5f59eec1c208741677d4",
  "4bba627a7ddb4f98ffc72b8f6ef633f7af6d0528c92baae1e0ca5643521e34eb",
  "393457db8908a85390d612717c517cf4134b7cd54f8cefcff901b924bcd76f60",
  "e29abae80aea09053949b4f6ffe4949ebbdd4c195a210ea81caca6a88a10e09c",
  "ecb381dff4c1c6f39eb6abaeb48f18af686c355593c0048290083a11efea7d2a",
  "140dea0a209e9ff919abe6cf082f728c09ee8847619804fc22d9aa1f14d02621",
  "660173658c7dbb8537af851d7fa36da7cab022ff927a5e564c6fbc932d0779aa",
  "11c5d085de9e4dcf8bc60dfaae48baab6af242408e81ab99b8b88173f9ca5b7d",
  "0e5473e9ec18afd1152e04cccbd4b83b36ceb1cc83ccbd00e9674449bb86f400",
  "c26b680b4545d7b6cf6e36af427bb639f2c1a1c80154ee8dd948a6741ba56f26"
]);

export async function removeLegacyDemoKnowledge(entries: KnowledgeEntry[]): Promise<KnowledgeEntry[]> {
  // Preserve company records if this page is opened outside a secure browser context.
  if (!globalThis.crypto?.subtle) return entries;
  const retained = await Promise.all(entries.map(async (entry) => {
    const bytes = new TextEncoder().encode(`${entry.id}\0${entry.title}\0${entry.content}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const signature = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    return LEGACY_DEMO_SIGNATURES.has(signature) ? null : entry;
  }));
  return retained.filter((entry): entry is KnowledgeEntry => entry !== null);
}
