import { Magnetic } from '../lib/Magnetic';
import { ICON } from '../lib/assets';

/**
 * The header for every page that isn't the landing page itself.
 *
 * Unlike `Chrome.tsx`'s `Header`, this one doesn't track scroll — there's no
 * transparent hero underneath it to reveal, so it can just stay solid from
 * the first frame. It also doesn't smooth-scroll to hash targets on its own
 * page, because it doesn't have one: every link here leaves for the landing
 * page or another subpage.
 *
 * @param root Path back to the site root — `../` from any of these pages,
 *   since each lives one directory down so its own URL can drop the .html
 *   extension (see Footer.tsx for the same reasoning applied there).
 */
export function SubpageHeader({ root }: { root: string }) {
  return (
    <header className="is-stuck">
      <div className="wrap bar">
        <a className="brand" href={`${root}index.html`}>
          <img src={ICON} alt="" width={27} height={27} />
          <span>Campus Connect</span>
        </a>
        <nav>
          <a className="hide-sm" href={`${root}index.html#what`}>What it does</a>
          <a className="hide-sm" href={`${root}index.html#private`}>Privacy</a>
          <a className="hide-sm" href={`${root}changelog/`}>Changelog</a>
          <Magnetic strength={7}>
            <a className="btn btn--go btn--sm" href={`${root}index.html#get`}>Download</a>
          </Magnetic>
        </nav>
      </div>
    </header>
  );
}
