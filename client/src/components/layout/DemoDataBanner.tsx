import { demoDataStatus } from "../../demo/mode";

/**
 * A standing notice that the interface is showing placeholder data.
 *
 * The demonstration is useful precisely because it looks like the product, which
 * is also the risk: someone could mistake a demonstration for the registry and
 * draw a conclusion from it. So while demo data is on, every screen says so, at
 * the top, in the same place on every page.
 *
 * It renders nothing at all when demo data is off, so it costs a production
 * visitor nothing and cannot be mistaken for a real banner.
 */
export function DemoDataBanner(): JSX.Element | null {
  const status = demoDataStatus();
  if (!status.enabled) return null;

  return (
    <div className="demo-banner" role="status" aria-live="polite">
      <div className="container demo-banner__inner">
        <strong className="demo-banner__title">Demonstration data</strong>
        <span className="demo-banner__body">
          Every batch, participant and report on these screens is placeholder data for review.
          Nothing here is a real agricultural record, and no transaction has been sent to a
          blockchain. Set <code>VITE_DEMO_DATA</code> to anything other than{" "}
          <code>true</code> to read from the registry.
        </span>
      </div>
    </div>
  );
}
