import React from 'react';
import type { ClipboardHistoryEntry, Snippet } from '../shared/types';
import type { QuickPasteItems } from '../shared/bridge';
import { relativeTime } from './format';
import { BookmarkIcon, ClipboardIcon, ImageIcon, SearchIcon } from './icons';

import { api } from './api';
/**
 * The overlay that appears over whatever you are working in.
 *
 * Every decision here is about the two seconds between pressing the hotkey and
 * having the text where you wanted it. There is no chrome, no navigation and
 * nothing to click before you can type; the search field is focused on arrival,
 * the first result is always selected, and Enter takes it. The mouse is
 * supported but nobody should need it.
 */

type Row =
  | { kind: 'clip'; id: string; entry: ClipboardHistoryEntry }
  | { kind: 'snippet'; id: string; snippet: Snippet };

/** Enough to scroll through, few enough to render instantly. */
const MAX_ROWS = 50;

export function QuickPasteOverlay() {
  const [items, setItems] = React.useState<QuickPasteItems>({ clips: [], snippets: [], roomNames: {} });
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    api.quickPasteItems().then(setItems);

    /*
     * The window is hidden rather than destroyed between uses, so a fresh open
     * has to reset it — otherwise it reappears showing last time's search and
     * last time's history.
     */
    return api.onQuickPasteOpened((next) => {
      setItems(next);
      setQuery('');
      setActive(0);
      // The window has only just been shown; focusing on the next frame is what
      // makes typing work immediately rather than after a click.
      requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, []);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const rows = React.useMemo(() => {
    const needle = query.trim().toLowerCase();

    const snippets: Row[] = items.snippets
      .filter(
        (snippet) =>
          !needle ||
          snippet.label.toLowerCase().includes(needle) ||
          snippet.content.toLowerCase().includes(needle)
      )
      .map((snippet) => ({ kind: 'snippet' as const, id: snippet.id, snippet }));

    const clips: Row[] = items.clips
      .filter((entry) => !needle || entry.text.toLowerCase().includes(needle))
      .map((entry) => ({ kind: 'clip' as const, id: entry.id, entry }));

    /*
     * Snippets first, but only while searching. With an empty query the point of
     * the overlay is "what did I just copy", so history leads; the moment you
     * type something you are looking for a thing you kept, so snippets lead.
     */
    return (needle ? [...snippets, ...clips] : [...clips, ...snippets]).slice(0, MAX_ROWS);
  }, [items, query]);

  // A shrinking result list must never leave the selection past the end.
  React.useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  React.useEffect(() => {
    listRef.current
      ?.querySelector('.qp-row.is-active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, rows.length]);

  function choose(row: Row | undefined) {
    if (row) {
      void api.quickPastePick(row.kind, row.id);
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      void api.quickPasteClose();
      return;
    }

    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setActive((current) => Math.min(rows.length - 1, current + 1));
      return;
    }

    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setActive((current) => Math.max(0, current - 1));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      choose(rows[active]);
      return;
    }

    /*
     * Alt+1..9 jumps straight to a row. Plain digits cannot be used because the
     * field is a search box and people search for numbers.
     */
    if (event.altKey && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      choose(rows[Number(event.key) - 1]);
    }
  }

  return (
    <div className="qp" onKeyDown={onKeyDown}>
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
          placeholder="Search what you copied, and your snippets…"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="qp__count">{rows.length}</span>
      </div>

      <div className="qp__list" ref={listRef}>
        {rows.length === 0 ? (
          <div className="qp__empty">
            {query ? `Nothing matches “${query}”.` : 'Nothing copied yet on this device.'}
          </div>
        ) : (
          rows.map((row, index) => (
            <button
              key={`${row.kind}:${row.id}`}
              className={index === active ? 'qp-row is-active' : 'qp-row'}
              onMouseMove={() => setActive(index)}
              onClick={() => choose(row)}
            >
              <span className={row.kind === 'snippet' ? 'qp-row__icon is-snippet' : 'qp-row__icon'}>
                {row.kind === 'snippet' ? (
                  <BookmarkIcon size={14} />
                ) : row.entry.kind === 'image' ? (
                  <ImageIcon size={14} />
                ) : (
                  <ClipboardIcon size={14} />
                )}
              </span>

              <span className="qp-row__body">
                <span className="qp-row__text">
                  {row.kind === 'snippet'
                    ? row.snippet.label || row.snippet.content
                    : row.entry.kind === 'image'
                      ? 'Image'
                      : row.entry.text}
                </span>
                <span className="qp-row__meta">
                  {row.kind === 'snippet'
                    ? row.snippet.label
                      ? `Snippet · ${oneLine(row.snippet.content)}`
                      : 'Snippet'
                    : `${items.roomNames[row.entry.roomId] ?? 'A room you have left'} · ${row.entry.deviceName} · ${relativeTime(row.entry.timestamp)}`}
                </span>
              </span>

              {index < 9 ? <span className="qp-row__key">Alt {index + 1}</span> : null}
            </button>
          ))
        )}
      </div>

      <div className="qp__footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> paste
        </span>
        <span>
          <kbd>Alt</kbd>+<kbd>1–9</kbd> jump
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </div>
  );
}

/** Snippets keep their line breaks; a one-line preview must not. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}
