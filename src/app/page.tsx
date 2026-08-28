import styles from "./page.module.css";
import { ChangeGateWebMcp } from "./changegate-webmcp";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <p className={styles.eyebrow}>2026 OpenAI WebMCP Challenge</p>
        <h1>ChangeGate</h1>
        <p className={styles.summary}>
          A synthetic change simulator with separate human approval, execution,
          and independent refund verification.
        </p>
        <section className={styles.notice} aria-label="Gate 4 scope">
          <h2>Gate 4: verified synthetic refund</h2>
          <p>
            The agent may inspect, propose, and request review. Only a person using
            this visible interface may approve or reject the exact proposal.
            Refund execution requires a second human decision. Success is shown
            only after independent ledger verification. Gateway execution is unavailable.
          </p>
          <ChangeGateWebMcp />
        </section>
      </main>
    </div>
  );
}
