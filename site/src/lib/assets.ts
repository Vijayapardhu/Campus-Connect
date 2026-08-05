import iconUrl from '../assets/icon.png';

/*
 * The logo, imported rather than written as a path.
 *
 * `<img src="./icon.png">` is a string Vite never sees, so it resolves
 * against whatever directory the page happens to sit in — fine at the site
 * root, broken from /build/. Importing it makes the URL Vite's problem: it
 * emits the file once, fingerprinted, and rewrites every reference relative
 * to the chunk that uses it. Every chunk lives in assets/, so the same URL is
 * correct from any page depth.
 */
export const ICON = iconUrl;
