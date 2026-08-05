import raw from './release.json';

/*
 * What the download buttons point at.
 *
 * The page used to carry the version and the three installer URLs in its
 * markup, and a release workflow rewrote the HTML in place. Now that the page
 * is built rather than hand-written, that would mean editing a build artifact
 * — so the release writes release.json instead and the site is rebuilt from
 * it. The shape is checked here so a malformed write fails the build rather
 * than shipping a page with three dead buttons on it.
 */
export type Platform = 'win' | 'mac' | 'linux';

export interface ReleaseAsset {
  file: string;
  size: string;
  url: string;
}

export interface Release {
  tag: string;
  version: string;
  assets: Record<Platform, ReleaseAsset>;
}

const PLATFORMS: Platform[] = ['win', 'mac', 'linux'];

function build(): Release {
  const assets = {} as Record<Platform, ReleaseAsset>;

  for (const platform of PLATFORMS) {
    const asset = raw.assets[platform];
    if (!asset?.file) {
      throw new Error(
        `release.json is missing the ${platform} installer. Run scripts/sync-site-version.js.`
      );
    }
    assets[platform] = {
      file: asset.file,
      size: asset.size,
      url: `${raw.downloadBase}/${raw.tag}/${asset.file}`
    };
  }

  return { tag: raw.tag, version: raw.version, assets };
}

export const release = build();
