import React from 'react';
import type { SearchHit } from '../shared/types';
import { relativeTime } from './format';
import { ChatIcon, ClipboardIcon, SearchIcon } from './icons';

import { api } from './api';
/**
 * The command palette, and the search that shares its shape.
 *
 * One surface doing two jobs, because they are the same job from the user's
 * side: you know what you want and you would rather type it than go and find
 * it. Typing a plain word runs a command; typing `>` — or opening it with the
 * search shortcut — searches everything you have ever copied or been sent.
 */

export type Command = {
  id: string;
  label: string;
  /** What it does, and where it lives, shown to the right. */
  hint?: string;
  /** Extra words that should match it, never displayed. */
  keywords?: string;
  icon?: React.ReactNode;
  group: string;
  run: () => void;
};

export type PaletteMode = 'commands' | 'search';

/**
 * Subsequence matching, the way every palette works.
 *
 * `crm` should find "Create room", because that is what fingers actually type
 * when they know where they are going. Scoring rewards matches that start a
 * word, so "room" ranks "Create **room**" above "Rename this **r**o**oom**"-style
 * accidents.
 */
export function fuzzyScore(text: string, query: string): number {
  if (!query) {
    return 1;
  }

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  let score = 0;
  let at = -1;

  for (const character of needle) {
    if (character === ' ') {
      continue;
    }

    at = haystack.indexOf(character, at + 1);
    if (at === -1) {
      return 0;
    }

    // A character that begins a word is worth far more than one in the middle.
    const startsWord = at === 0 || /[\s\-_/:.]/.test(haystack[at - 1]);
    score += startsWord ? 10 : 1;
  }

  // Shorter labels win ties, so "Chat" beats "Chat notification settings".
  return score + Math.max(0, 20 - haystack.length / 4);
}

export function rankCommands(commands: Command[], query: string): Command[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return commands;
  }

  return commands
    .map((command) => ({
      command,
      score: Math.max(
        fuzzyScore(command.label, trimmed),
        fuzzyScore(`${command.group} ${command.label} ${command.keywords ?? ''}`, trimmed) * 0.6
      )
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.command);
}

export function CommandPalette({
  commands,
  initialMode,
  onClose,
  onOpenHit
}: {
  commands: Command[];
  initialMode: PaletteMode;
  onClose: () => void;
  onOpenHit: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = React.useState(initialMode === 'search' ? '>' : '');
  const [active, setActive] = React.useState(0);
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [searching, setSearching] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const searchMode = query.startsWith('>');
  const term = searchMode ? query.slice(1).trim() : query;

  React.useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    // Land the caret after the '>' rather than selecting it, so typing
    // continues the search instead of replacing the prefix.
    input?.setSelectionRange(query.length, query.length);
    // Only on mount: re-running would fight the user's cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Debounced, because search runs over every message and every clipboard entry
   * in every room. At three keystrokes a second an undebounced search would do
   * that work twice for every result anyone actually reads.
   */
  React.useEffect(() => {
    if (!searchMode || term.length === 0) {
      setHits([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    let cancelled = false;

    const timer = window.setTimeout(() => {
      api.searchAll(term).then((results) => {
        if (!cancelled) {
          setHits(results);
          setSearching(false);
        }
      });
    }, 140);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchMode, term]);

  const ranked = React.useMemo(
    () => (searchMode ? [] : rankCommands(commands, query)),
    [commands, query, searchMode]
  );

  const count = searchMode ? hits.length : ranked.length;

  React.useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, count - 1)));
  }, [count]);

  React.useEffect(() => {
    listRef.current?.querySelector('.qp-row.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active, count]);

  function choose(index: number) {
    if (searchMode) {
      const hit = hits[index];
      if (hit) {
        onOpenHit(hit);
        onClose();
      }
      return;
    }

    const command = ranked[index];
    if (command) {
      // Closed first, so a command that opens a dialog does not fight this one
      // for the screen.
      onClose();
      command.run();
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(count - 1, current + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    }
  }

  let lastGroup = '';

  return (
    <div className="overlay overlay--top" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="qp palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="qp__search">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            className="qp__input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder="Type a command, or > to search everything"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="qp__count">{searching ? '…' : count}</span>
        </div>

        <div className="qp__list" ref={listRef}>
          {count === 0 ? (
            <div className="qp__empty">
              {searchMode
                ? term
                  ? searching
                    ? 'Searching…'
                    : `Nothing matches “${term}”.`
                  : 'Type to search your clipboard history and every room’s chat.'
                : `No command matches “${query}”.`}
            </div>
          ) : searchMode ? (
            hits.map((hit, index) => (
              <button
                key={`${hit.kind}:${hit.id}`}
                className={index === active ? 'qp-row is-active' : 'qp-row'}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <span className="qp-row__icon">
                  {hit.kind === 'chat' ? <ChatIcon size={14} /> : <ClipboardIcon size={14} />}
                </span>
                <span className="qp-row__body">
                  <span className="qp-row__text">
                    <Highlighted hit={hit} />
                  </span>
                  <span className="qp-row__meta">
                    {hit.roomName} · {hit.deviceName} · {relativeTime(hit.timestamp)}
                    {hit.fileName ? ` · ${hit.fileName}` : ''}
                  </span>
                </span>
              </button>
            ))
          ) : (
            ranked.map((command, index) => {
              const heading = command.group !== lastGroup && !query.trim() ? command.group : '';
              lastGroup = command.group;

              return (
                <React.Fragment key={command.id}>
                  {heading ? <div className="palette__group">{heading}</div> : null}
                  <button
                    className={index === active ? 'qp-row is-active' : 'qp-row'}
                    onMouseMove={() => setActive(index)}
                    onClick={() => choose(index)}
                  >
                    <span className="qp-row__icon">{command.icon}</span>
                    <span className="qp-row__body">
                      <span className="qp-row__text">{command.label}</span>
                      {command.hint ? <span className="qp-row__meta">{command.hint}</span> : null}
                    </span>
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="qp__footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> run
          </span>
          <span>
            <kbd>&gt;</kbd> search everything
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

/** Shows where the match actually is, rather than leaving it to be hunted for. */
function Highlighted({ hit }: { hit: SearchHit }) {
  const before = hit.excerpt.slice(0, hit.matchStart);
  const match = hit.excerpt.slice(hit.matchStart, hit.matchStart + hit.matchLength);
  const after = hit.excerpt.slice(hit.matchStart + hit.matchLength);

  return (
    <>
      {before}
      <mark className="hit__mark">{match}</mark>
      {after}
    </>
  );
}
