import styles from "./page.module.css";
import { ChangeGateWebMcp } from "./changegate-webmcp";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <p className={styles.eyebrow}>2026 OpenAI WebMCP Challenge</p>
        <h1>ChangeGate</h1>
        <p className={styles.summary}>
          A human-controlled IT-operations simulator with a safe, inspection-first
          browser agent boundary.
        </p>
        <section className={styles.notice} aria-label="Gate 2 scope">
          <h2>Gate 2: safe WebMCP boundary</h2>
          <p>
            Inspection, proposal, and human-review-request tools are available.
            Human approval and consequential execution remain deliberately absent.
          </p>
          <ChangeGateWebMcp />
        </section>
      </main>
    </div>
  );
}
