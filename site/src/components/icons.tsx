import type { ComponentType } from 'react';
import { siApple, siLinux } from 'simple-icons';
import {
  Monitor,
  Users,
  Presentation,
  WifiOff,
  ClipboardCopy,
  Send,
  MessagesSquare,
  Video,
  Smartphone,
  KeyRound,
  Search,
  ScreenShare,
  ArrowRight,
  type LucideProps
} from 'lucide-react';

/*
 * Icons, from sets rather than from hand.
 *
 * These were drawn by hand on a 24-unit grid, which is fine until you put ten
 * of them in a row and the optical weights disagree — one mark a shade too
 * heavy, another sitting a pixel low, and the set reads as almost-consistent,
 * which is worse than either extreme. Lucide is drawn to one specification
 * across six thousand marks.
 *
 * Wrapped rather than re-exported so the size and stroke weight are decided
 * once here. Lucide's own defaults are 24px at stroke 2, which is heavier than
 * this page wants and would have meant repeating two props at every call.
 */
function tuned(Icon: ComponentType<LucideProps>) {
  return ({ size = 19 }: { size?: number }) => (
    <Icon size={size} strokeWidth={1.8} absoluteStrokeWidth aria-hidden="true" />
  );
}

export const ScreenIcon = tuned(Monitor);
export const PeopleIcon = tuned(Users);
export const PresentIcon = tuned(Presentation);
export const NoWifiIcon = tuned(WifiOff);
export const ClipboardIcon = tuned(ClipboardCopy);
export const TransferIcon = tuned(Send);
export const RoomIcon = tuned(MessagesSquare);
export const CallIcon = tuned(Video);
export const PhoneIcon = tuned(Smartphone);
export const LockIcon = tuned(KeyRound);
export const SearchIcon = tuned(Search);
export const ShareIcon = tuned(ScreenShare);

export const ArrowIcon = () => (
  <ArrowRight size={14} strokeWidth={2.2} absoluteStrokeWidth aria-hidden="true" />
);

/* ------------------------------------------------------- platform marks -- */

/*
 * Brand marks are recognised as shapes, so these are the real paths rather
 * than an impression of them — Simple Icons' own, which are CC0 and shipped
 * as a package, so nothing is copied by eye and nothing is fetched from a
 * CDN. The Tux this replaces was a cartoon assembled out of ellipses.
 */
function BrandMark({ path, title }: { path: string; title: string }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label={title}>
      <path d={path} />
    </svg>
  );
}

export const AppleMark = () => <BrandMark path={siApple.path} title="Apple" />;
export const LinuxMark = () => <BrandMark path={siLinux.path} title="Linux" />;

/*
 * Windows, drawn here because Simple Icons removed Microsoft's marks over
 * trademark policy. This is the Windows 11 logo: four equal squares on a 2×2
 * grid — geometry rather than illustration, so there is nothing to get subtly
 * wrong by eye.
 */
export const WindowsMark = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Windows">
    <rect x="3" y="3" width="8.2" height="8.2" rx="0.7" />
    <rect x="12.8" y="3" width="8.2" height="8.2" rx="0.7" />
    <rect x="3" y="12.8" width="8.2" height="8.2" rx="0.7" />
    <rect x="12.8" y="12.8" width="8.2" height="8.2" rx="0.7" />
  </svg>
);
