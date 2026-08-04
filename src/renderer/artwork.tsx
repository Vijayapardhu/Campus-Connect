import React from 'react';

/**
 * The tour's illustrations.
 *
 * Drawn rather than screenshotted, and built rather than sketched. A screenshot
 * of an empty install is a picture of nothing and ages the moment the interface
 * moves — but a diagram of circles and lines is not much better, because it
 * describes the idea instead of showing it.
 *
 * These are made from the same vocabulary as the app — its radii, its accent,
 * its borders — with the three things the first attempt was missing: depth, so
 * a scene has a foreground; a gradient, so the accent behaves like a light
 * source rather than a fill; and one small movement each, so the idea happens
 * rather than being labelled.
 *
 * Every animation is driven from a class, so `prefers-reduced-motion` stops all
 * of them in one rule instead of each having to remember.
 */

/** Shared gradients, and the soft pool of light each scene sits in. */
function ArtDefs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-accent`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" className="tour__grad-from" />
        <stop offset="100%" className="tour__grad-to" />
      </linearGradient>
      <radialGradient id={`${id}-glow`}>
        <stop offset="0%" className="tour__glow-from" />
        <stop offset="100%" className="tour__glow-to" />
      </radialGradient>
    </defs>
  );
}

/** A screen on a stand, at whatever size the scene needs. */
function Screen({
  x,
  y,
  w,
  h,
  gradient
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  gradient: string;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="6" className="tour__screen" />
      <rect x={x + 4} y={y + 4} width={w - 8} height={h - 12} rx="3" fill={`url(#${gradient})`} />
      <rect x={x + w / 2 - 8} y={y + h + 1} width="16" height="3" rx="1.5" className="tour__stand" />
    </g>
  );
}

export function ArtNetwork() {
  return (
    <svg viewBox="0 0 280 150" className="tour__art" aria-hidden="true">
      <ArtDefs id="net" />
      <ellipse cx="140" cy="80" rx="124" ry="60" fill="url(#net-glow)" />

      {/* Drawn before the devices, so the devices sit on top of the wires. */}
      <path id="net-a" d="M74 60 Q140 28 206 60" className="tour__wire" />
      <path id="net-b" d="M74 60 Q104 102 140 106" className="tour__wire" />
      <path id="net-c" d="M206 60 Q176 102 140 106" className="tour__wire" />

      {/* What actually travels. Staggered, so it reads as a network rather
          than as three things moving in step. */}
      {[
        { path: '#net-a', begin: '0s' },
        { path: '#net-c', begin: '0.9s' },
        { path: '#net-b', begin: '1.8s' }
      ].map((packet) => (
        <circle key={packet.path} r="3.5" className="tour__packet">
          <animateMotion dur="2.7s" repeatCount="indefinite" begin={packet.begin}>
            <mpath href={packet.path} />
          </animateMotion>
        </circle>
      ))}

      <Screen x={48} y={42} w={52} h={34} gradient="net-accent" />
      <Screen x={180} y={42} w={52} h={34} gradient="net-accent" />
      <Screen x={108} y={86} w={64} h={40} gradient="net-accent" />
    </svg>
  );
}

export function ArtRooms() {
  return (
    <svg viewBox="0 0 280 150" className="tour__art" aria-hidden="true">
      <ArtDefs id="rooms" />
      <ellipse cx="92" cy="76" rx="88" ry="54" fill="url(#rooms-glow)" />

      {/* The room you are in: lit, solid, with something moving through it. */}
      <rect x="24" y="28" width="132" height="94" rx="14" className="tour__room" />
      <circle cx="56" cy="58" r="11" fill="url(#rooms-accent)" />
      <circle cx="82" cy="58" r="11" fill="url(#rooms-accent)" />
      <circle cx="108" cy="58" r="11" fill="url(#rooms-accent)" />

      <g className="tour__note-fly">
        <rect x="58" y="82" width="64" height="28" rx="7" className="tour__note" />
        <rect x="67" y="91" width="36" height="4" rx="2" className="tour__note-line" />
        <rect x="67" y="100" width="24" height="4" rx="2" className="tour__note-line is-short" />
      </g>

      {/* The room you are not in: dashed, unlit, and nothing crosses to it. */}
      <rect x="172" y="28" width="84" height="94" rx="14" className="tour__room is-other" />
      <circle cx="198" cy="58" r="11" className="tour__face is-muted" />
      <circle cx="224" cy="58" r="11" className="tour__face is-muted" />
      <rect x="188" y="82" width="52" height="28" rx="7" className="tour__note is-muted" />
    </svg>
  );
}

export function ArtShortcut() {
  return (
    <svg viewBox="0 0 280 150" className="tour__art" aria-hidden="true">
      <ArtDefs id="keys" />
      <ellipse cx="140" cy="100" rx="116" ry="46" fill="url(#keys-glow)" />

      {/* The overlay the shortcut summons, rising out of the keys below it. */}
      <g className="tour__overlay-pop">
        <rect x="74" y="14" width="132" height="62" rx="11" className="tour__panel" />
        <rect x="86" y="26" width="108" height="13" rx="4.5" fill="url(#keys-accent)" />
        <rect x="86" y="45" width="84" height="8" rx="4" className="tour__row" />
        <rect x="86" y="58" width="96" height="8" rx="4" className="tour__row" />
      </g>

      {/* Keycaps with a side face, so they read as objects that depress. */}
      {[
        { x: 44, accent: false },
        { x: 112, accent: false },
        { x: 180, accent: true }
      ].map((key) => (
        <g key={key.x}>
          <rect x={key.x} y={104} width={56} height={28} rx="8" className="tour__key-side" />
          <rect
            x={key.x}
            y={97}
            width={56}
            height={28}
            rx="8"
            className={key.accent ? 'tour__key-top is-accent' : 'tour__key-top'}
          />
          <rect
            x={key.x + 17}
            y={109}
            width={22}
            height={4}
            rx="2"
            className={key.accent ? 'tour__key-glyph is-invert' : 'tour__key-glyph'}
          />
        </g>
      ))}
    </svg>
  );
}

export function ArtTray() {
  return (
    <svg viewBox="0 0 280 150" className="tour__art" aria-hidden="true">
      <ArtDefs id="tray" />
      <ellipse cx="140" cy="68" rx="116" ry="52" fill="url(#tray-glow)" />

      {/* The window on its way down — the movement is the explanation. */}
      <g className="tour__window-tuck">
        <rect x="70" y="14" width="140" height="80" rx="12" className="tour__screen" />
        <path d="M70 26 a12 12 0 0 1 12 -12 h116 a12 12 0 0 1 12 12 z" className="tour__titlebar" />
        <circle cx="84" cy="24" r="3" className="tour__dot-chrome" />
        <circle cx="95" cy="24" r="3" className="tour__dot-chrome" />
        <circle cx="106" cy="24" r="3" className="tour__dot-chrome" />
        <rect x="84" y="46" width="76" height="6" rx="3" className="tour__note-line" />
        <rect x="84" y="60" width="50" height="6" rx="3" className="tour__note-line is-short" />
        <rect x="84" y="74" width="62" height="6" rx="3" className="tour__note-line is-short" />
      </g>

      {/* The tray it tucks into, with the icon that is still doing the work. */}
      <rect x="32" y="112" width="216" height="28" rx="10" className="tour__taskbar" />
      <rect x="196" y="119" width="14" height="14" rx="4" fill="url(#tray-accent)" />
      <circle cx="222" cy="126" r="4" className="tour__face is-muted" />
      <circle cx="236" cy="126" r="4" className="tour__face is-muted" />
      <circle cx="210" cy="117" r="4" className="tour__tray-badge" />
    </svg>
  );
}
