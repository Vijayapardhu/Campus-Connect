import { useEffect, useState } from 'react';
import { Magnetic } from '../lib/Magnetic';
import { ICON } from '../lib/assets';

const NAV = [
  { href: '#campus', label: 'For campuses' },
  { href: '#what', label: 'What it does' },
  { href: '#private', label: 'Privacy' },
  { href: '#faq', label: 'FAQ' },
  { href: '#maker', label: 'Developer' }
];

/*
 * The header gains a background once the page has moved.
 *
 * Over the hero it is transparent, because a bar with a fill sitting on top
 * of the shader is a horizontal line across the one part of the page that is
 * meant to feel open. `passive` so the listener can never hold up a scroll
 * frame — Lenis is already driving the position and this only reads it.
 */
export function Header() {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={stuck ? 'is-stuck' : undefined}>
      <div className="wrap bar">
        <a className="brand" href="#top">
          <img src={ICON} alt="" width={27} height={27} />
          <span>Campus Connect</span>
        </a>
        <nav>
          {NAV.map((item) => (
            <a key={item.href} className="hide-sm" href={item.href}>
              {item.label}
            </a>
          ))}
          <Magnetic strength={7}>
            <a className="btn btn--go btn--sm" href="#get">Download</a>
          </Magnetic>
        </nav>
      </div>
    </header>
  );
}

/* The footer outgrew this file — see components/Footer.tsx. */
