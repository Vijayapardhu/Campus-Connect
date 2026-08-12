import { Footer } from './Footer';
import { SubpageHeader } from './Header';

/*
 * This page is served from /terms/, so everything at the site root is one
 * directory up — see Footer.tsx and Header.tsx for the same reasoning
 * applied there.
 */
const ROOT = '../';

export default function TermsPage() {
  return (
    <>
      <SubpageHeader root={ROOT} />

      <main className="doc">
        <div className="wrap">
          <h1>Terms and Conditions</h1>
          <p className="updated">Last updated 7 August 2026</p>
          <p className="intro">
            Campus Connect is free, open-source software under the MIT License. It is a program you
            run, not a service anyone operates for you &mdash; which shapes everything below.
          </p>

          <div className="callout">
            <p>
              <strong>The short version.</strong> Use it for anything you like, including
              commercially. It comes with no warranty. Nobody is running a service on your behalf, so
              there is nothing to go down &mdash; and nothing anybody owes you if it does.
            </p>
          </div>

          <h2>Your licence</h2>
          <p>
            The software is provided under the{' '}
            <a href="https://github.com/Vijayapardhu/Campus-Connect/blob/main/LICENSE">MIT License</a>. In
            plain terms that lets you use, copy, modify, merge, publish, distribute, sublicense and
            sell copies, provided the copyright notice and licence text travel with it.
          </p>
          <p>Where anything here disagrees with the MIT License, the licence wins.</p>

          <h2>There is no service</h2>
          <p>
            Campus Connect runs entirely on your own machines. No account is created, nothing is
            transmitted to the author, and no infrastructure sits behind it. So:
          </p>
          <ul>
            <li>There is no uptime commitment, because nothing is hosted to be up.</li>
            <li>There is no support obligation, though questions are welcome in the open.</li>
            <li>Nobody can access, recover, delete or hand over your data, because nobody else ever
            has it.</li>
          </ul>

          <h2>No warranty</h2>
          <p>
            The software is provided <strong>&ldquo;as is&rdquo;</strong>, without warranty of any
            kind, express or implied, including the warranties of merchantability, fitness for a
            particular purpose and non-infringement. The authors and copyright holders are not liable
            for any claim, damages or other liability arising from the software or its use.
          </p>
          <p>
            Less formally: this is a student project shared in good faith and tested as thoroughly as
            one person reasonably can. Do not make it the only copy of anything you cannot afford to
            lose.
          </p>

          <h2>Using it responsibly</h2>
          <p>
            The software gives you real capabilities on a shared network &mdash; reading a clipboard,
            moving files, messaging or calling another device directly, and with permission,
            controlling another computer. Using them lawfully and with consent is your responsibility.
          </p>
          <ul>
            <li>Only connect to, message or call devices you own or have been invited to.</li>
            <li>Remote desktop requires the other machine to accept, every time. Do not work around
            that, and do not ask anyone else to.</li>
            <li>Follow your institution&rsquo;s acceptable-use policy. A campus network is somebody
            else&rsquo;s network, and its rules apply to you on it.</li>
            <li>Do not use it to reach, take or share anything you have no right to.</li>
          </ul>

          <h2>Security</h2>
          <p>
            The encryption is documented and the source is public precisely so the claims can be
            checked rather than believed. No software is free of flaws. If you find one, report it as
            described in{' '}
            <a href="https://github.com/Vijayapardhu/Campus-Connect/blob/main/SECURITY.md">
              SECURITY.md
            </a>{' '}
            rather than posting it publicly first.
          </p>

          <h2>Installers and updates</h2>
          <p>
            Builds are not code-signed, so Windows and macOS warn that the publisher cannot be
            verified. That warning is accurate: the operating system genuinely cannot confirm who
            produced the file. Download only from{' '}
            <a href="https://github.com/Vijayapardhu/Campus-Connect/releases">
              the official releases page
            </a>
            , or build from source.
          </p>

          <h2>Trademarks</h2>
          <p>
            Windows, macOS and Linux are trademarks of their respective owners. Their names and marks
            appear on this site only to indicate which platforms the software runs on.
          </p>

          <h2>Changes</h2>
          <p>
            These terms may change as the project does. The date at the top reflects the current
            version, and every revision is visible in the repository&rsquo;s history.
          </p>
        </div>
      </main>

      <Footer prefix={ROOT} />
    </>
  );
}
