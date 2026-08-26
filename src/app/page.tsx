import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <p className={styles.eyebrow}>2026 OpenAI WebMCP Challenge</p>
        <h1>ChangeGate</h1>
        <p className={styles.summary}>
          A future human-controlled IT-operations simulator. Gate 0.5 freezes
          the architecture and deterministic scenario contract only.
        </p>
        <section className={styles.notice} aria-label="Gate 0 scope">
          <h2>Gate 0.5: architecture foundation</h2>
          <p>
            No simulated services, WebMCP tools, authorization workflow, or
            change execution is implemented in this scaffold.
          </p>
        </section>
      </main>
    </div>
  );
}
