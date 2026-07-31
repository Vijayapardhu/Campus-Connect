import { MAX_SNIPPETS, type Snippet } from '../shared/types';

/**
 * The snippet library.
 *
 * Small enough that it could have lived in main.ts, kept separate because the
 * ranking is the whole point and ranking is the kind of thing that is worth
 * being able to test. A library that always shows you the same alphabetical list
 * is a library you stop opening.
 *
 * Free of Electron imports so it runs in plain Node.
 */

export interface SnippetPersistence {
  read(): Snippet[];
  write(snippets: Snippet[]): void;
}

/**
 * How long a use keeps counting for full value.
 *
 * Something used forty times last term should not outrank something used twice
 * this morning. Rather than decay every entry on a timer — which would mean
 * rewriting the whole library constantly — recency is folded into the sort.
 */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export class SnippetManager {
  private snippets: Snippet[];

  constructor(private readonly persistence: SnippetPersistence, private readonly now: () => number = Date.now) {
    this.snippets = [...persistence.read()];
  }

  /**
   * Most useful first: what you have reached for recently, then what you reach
   * for often, then what you made most recently.
   */
  list(): Snippet[] {
    const cutoff = this.now() - RECENT_MS;

    return [...this.snippets].sort((a, b) => {
      const recentA = a.lastUsedAt > cutoff;
      const recentB = b.lastUsedAt > cutoff;
      if (recentA !== recentB) {
        return recentA ? -1 : 1;
      }
      if (recentA && a.lastUsedAt !== b.lastUsedAt) {
        return b.lastUsedAt - a.lastUsedAt;
      }
      if (a.useCount !== b.useCount) {
        return b.useCount - a.useCount;
      }
      return b.createdAt - a.createdAt;
    });
  }

  get(id: string): Snippet | undefined {
    return this.snippets.find((snippet) => snippet.id === id);
  }

  /**
   * Adds a snippet, or updates one when an id is given.
   *
   * Identical content is not stored twice: saving the same command from the
   * clipboard three times should leave one snippet, not three. The existing one
   * is returned so the caller can say so.
   */
  save(input: { id?: string; label: string; content: string }): Snippet | null {
    const content = input.content.trim();
    if (!content) {
      return null;
    }

    const label = input.label.trim();

    if (input.id) {
      const existing = this.snippets.find((snippet) => snippet.id === input.id);
      if (!existing) {
        return null;
      }
      existing.label = label;
      existing.content = content;
      this.persist();
      return { ...existing };
    }

    const duplicate = this.snippets.find((snippet) => snippet.content === content);
    if (duplicate) {
      if (label && duplicate.label !== label) {
        duplicate.label = label;
        this.persist();
      }
      return { ...duplicate };
    }

    const snippet: Snippet = {
      id: `snip-${this.now().toString(36)}-${Math.floor(this.snippets.length + 1).toString(36)}`,
      label,
      content,
      createdAt: this.now(),
      useCount: 0,
      lastUsedAt: 0
    };

    this.snippets.unshift(snippet);

    /*
     * Over the cap, the least useful goes — the one that would have sorted last
     * anyway. Dropping the oldest instead would throw away the snippet you have
     * used every day for a year in favour of one you saved by accident.
     */
    if (this.snippets.length > MAX_SNIPPETS) {
      const ranked = this.list();
      const doomed = ranked[ranked.length - 1];
      this.snippets = this.snippets.filter((candidate) => candidate.id !== doomed.id);
    }

    this.persist();
    return { ...snippet };
  }

  /** Records that a snippet was actually used, which is what drives the order. */
  markUsed(id: string): Snippet | undefined {
    const snippet = this.snippets.find((candidate) => candidate.id === id);
    if (!snippet) {
      return undefined;
    }

    snippet.useCount += 1;
    snippet.lastUsedAt = this.now();
    this.persist();
    return { ...snippet };
  }

  remove(id: string): boolean {
    const before = this.snippets.length;
    this.snippets = this.snippets.filter((snippet) => snippet.id !== id);

    if (this.snippets.length === before) {
      return false;
    }

    this.persist();
    return true;
  }

  /** Ranked list filtered by a query, matched against both label and content. */
  search(query: string): Snippet[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return this.list();
    }

    return this.list().filter(
      (snippet) =>
        snippet.label.toLowerCase().includes(needle) || snippet.content.toLowerCase().includes(needle)
    );
  }

  private persist(): void {
    this.persistence.write(this.snippets);
  }
}
