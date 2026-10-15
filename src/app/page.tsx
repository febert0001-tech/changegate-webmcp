import Link from "next/link";
import styles from "./page.module.css";
import { ChangeGateWebMcp } from "./changegate-webmcp";

export default function Home() {
  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#console">Skip to control console</a>
      <nav className={styles.releaseproofNavigation} aria-label="ChangeGate navigation">
        <Link href="/releaseproof">ReleaseProof synthetic demo</Link>
        <span>Retained evidence · Ordinary browser · No WebMCP required</span>
      </nav>
      <main id="console" className={styles.main}><ChangeGateWebMcp /></main>
      <footer className={styles.footer}>
        <span>ChangeGate / 2026 WebMCP Challenge</span>
        <span>Synthetic ledger only · No real payments</span>
      </footer>
    </div>
  );
}
