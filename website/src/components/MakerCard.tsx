import { LEAFYCODE, LEAFYCODE_NAME, LEAFYCODE_URL } from "../lib/site.ts";
import { LeafyMark } from "./LeafyCredit.tsx";

/**
 * The maker's card: who builds Kriyon and how to reach them, in the same
 * spec-sheet cells as the rating plate. Details mirror leafycode.com/contact.
 */
export function MakerCard() {
  return (
    <section aria-labelledby="maker-name" className="maker">
      <div className="maker-head">
        <LeafyMark className="maker-mark" />
        <div className="maker-text">
          <span className="label">MAKER · AUTHOR(S)</span>
          <h3 className="maker-name" id="maker-name">
            {LEAFYCODE_NAME}
          </h3>
          <p className="maker-line">
            {LEAFYCODE.tagline} The software company in Sri Lanka that builds
            Kriyon, in the open.
          </p>
        </div>
        <a
          className="maker-go"
          href={LEAFYCODE_URL}
          rel="noreferrer"
          target="_blank"
        >
          LEAFYCODE.COM ↗
        </a>
      </div>
      <address className="maker-contact">
        <dl>
          <div className="maker-cell">
            <dt className="label">EMAIL</dt>
            <dd>
              <a href={`mailto:${LEAFYCODE.email}`}>{LEAFYCODE.email}</a>
            </dd>
          </div>
          <div className="maker-cell">
            <dt className="label">PHONE · WHATSAPP</dt>
            <dd>
              <a href={LEAFYCODE.phoneHref}>{LEAFYCODE.phone}</a>
              {" · "}
              <a href={LEAFYCODE.whatsappHref} rel="noreferrer" target="_blank">
                WhatsApp ↗
              </a>
            </dd>
          </div>
          <div className="maker-cell maker-cell-wide">
            <dt className="label">STUDIO</dt>
            <dd>
              <a href={LEAFYCODE.mapHref} rel="noreferrer" target="_blank">
                {LEAFYCODE.address} ↗
              </a>
            </dd>
          </div>
          <div className="maker-cell">
            <dt className="label">HOURS</dt>
            {LEAFYCODE.hours.map((line) => (
              <dd key={line}>{line}</dd>
            ))}
          </div>
          <div className="maker-cell">
            <dt className="label">ELSEWHERE</dt>
            <dd className="maker-social">
              {LEAFYCODE.social.map((s) => (
                <a href={s.href} key={s.label} rel="noreferrer" target="_blank">
                  {s.label}
                </a>
              ))}
            </dd>
          </div>
        </dl>
      </address>
    </section>
  );
}
