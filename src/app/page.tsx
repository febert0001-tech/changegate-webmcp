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
        <section className={styles.notice} aria-label="Gate 3 scope">
          <h2>Gate 3: human authorization plane</h2>
          <p>
            The agent may inspect, propose, and request review. Only a person using
            this visible interface may approve or reject the exact proposal.
            Consequential execution remains deliberately absent.
          </p>
          <ChangeGateWebMcp />
        </section>
      </main>
    </div>
  );
}
