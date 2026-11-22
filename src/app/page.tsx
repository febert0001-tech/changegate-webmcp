import Link from "next/link";
import merchantStyles from "./merchant/merchant.module.css";
import styles from "./page.module.css";
import { ChangeGateWebMcp } from "./changegate-webmcp";

export default function Home() {
  if (process.env.CHANGEGATE_STAGING_BUILD === "1") return <main className={merchantStyles.shell}>
    <article className={merchantStyles.frontDoor}>
      <p className={merchantStyles.brand}>MIDTOWN INTELLIGENCE LABS</p>
      <h1>ChangeGate</h1>
      <p>Check a refund against the original sale, send exceptions to a supervisor, and keep the record for your weekly close.</p>
      <Link className={merchantStyles.primary} href="/transactions">Merchant sign-in</Link>
      <p className={merchantStyles.fieldHint}>Staging · Test sales only</p>
    </article>
  </main>;

  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#console">Skip to control console</a>
      <main id="console" className={styles.main}><ChangeGateWebMcp /></main>
      <footer className={styles.footer}>
        <span>ChangeGate / 2026 WebMCP Challenge</span>
        <span>Synthetic ledger only · No real payments</span>
        <Link href="/merchant">Merchant workspace</Link>
      </footer>
    </div>
  );
}
