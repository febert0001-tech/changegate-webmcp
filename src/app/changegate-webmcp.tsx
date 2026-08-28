"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  createChangeGateOperations,
  createWebMcpOperationsFacade,
} from "../application/changegate-operations";
import { hasRefundProposalShape } from "../domain/refund";
import { getWebMcpModelContext } from "../webmcp/native-contract";
import { startWebMcpRegistration } from "../webmcp/registration";
import styles from "./page.module.css";

type Availability = "CHECKING" | "AVAILABLE" | "UNSUPPORTED" | "FAILED";
const LABELS: Readonly<Record<Availability, string>> = Object.freeze({
  CHECKING: "Checking browser support",
  AVAILABLE: "Available · 7 safe tools registered",
  UNSUPPORTED: "Unavailable in this browser",
  FAILED: "Registration unavailable",
});
const STAGES = [
  { title: "AI proposal", detail: "Agent prepares the change" },
  { title: "Human approval", detail: "Authorize the exact proposal" },
  { title: "Human execute", detail: "A separate human decision" },
  { title: "Independent verification", detail: "Read back the actual result" },
] as const;

export function ChangeGateWebMcp() {
  const [operations] = useState(() => createChangeGateOperations());
  const [webMcpOperations] = useState(() => createWebMcpOperationsFacade(operations));
  const [availability, setAvailability] = useState<Availability>("CHECKING");
  useSyncExternalStore(operations.subscribe, operations.getRevision, operations.getRevision);

  const proposal = operations.getChangeProposal();
  // Capture the lifecycle the person sees, never fetch a newer approval on click.
  const pendingExecution = operations.getPendingRefundExecution();
  const isRefund = proposal !== null && hasRefundProposalShape(proposal);
  const audit = operations.getAuditTrail();

  // Display only: never supply these values to an authorization or execution call.
  const lifecycle = proposal?.lifecycle ?? "NONE";
  const amount = isRefund && typeof proposal?.parameters.amountCents === "number"
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
      .format(proposal.parameters.amountCents / 100) : null;
  const tone = lifecycle === "SUCCEEDED" ? "success"
    : ["REJECTED", "FAILED", "EXPIRED", "ROLLBACK_FAILED"].includes(lifecycle) ? "danger"
    : ["AWAITING_HUMAN_APPROVAL", "APPROVED"].includes(lifecycle) ? "pending"
    : ["EXECUTING", "VERIFYING", "ROLLING_BACK"].includes(lifecycle) ? "active" : "neutral";
  const currentStage = lifecycle === "SUCCEEDED" ? 4
    : lifecycle === "VERIFYING" ? 3
    : lifecycle === "FAILED" ? (audit.events.at(-1)?.type === "REFUND_VERIFICATION_COMPLETED" ? 3 : 2)
    : ["APPROVED", "EXECUTING"].includes(lifecycle) ? 2
    : ["AWAITING_HUMAN_APPROVAL", "REJECTED", "EXPIRED"].includes(lifecycle) ? 1 : 0;
  const stopped = ["REJECTED", "FAILED", "EXPIRED"].includes(lifecycle);

  useEffect(() => {
    let mounted = true;
    const modelContext = getWebMcpModelContext(document);
    const session = startWebMcpRegistration(modelContext, webMcpOperations);
    void session.ready.then((result) => {
      if (!mounted) return;
      if (result.status === "REGISTERED") setAvailability("AVAILABLE");
      else if (result.status === "UNSUPPORTED") setAvailability("UNSUPPORTED");
      else setAvailability("FAILED");
    });
    return () => { mounted = false; session.dispose(); };
  }, [webMcpOperations]);

  return (
    <>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">CG</span>
          <div><h1>ChangeGate</h1><p>Verified Human Control Plane</p></div>
        </div>
        <div className={styles.headerBadges}>
          <span className={styles.environmentBadge}>Synthetic environment</span>
          <p className={styles.integrationStatus} data-availability={availability} role="status" aria-live="polite">
            <span className={styles.statusDot} aria-hidden="true" />
            <span><strong>WebMCP</strong> · {LABELS[availability]}</span>
          </p>
        </div>
      </header>
      <div className={styles.consoleBody}>
        <div className={styles.intro}>
          <div><p className={styles.eyebrow}>Human-governed change control</p>
            <h2>AI can propose. Humans authorize. <span>ChangeGate verifies.</span></h2>
          </div>
          <span className={styles.demoLabel}>DEMO / REFUND WORKFLOW</span>
        </div>
        <section aria-label="Authority flow" className={styles.flowPanel} data-tone={tone}>
          <ol className={styles.stepper}>
            {STAGES.map((stage, index) => {
              const state = index < currentStage ? "complete"
                : index === currentStage ? (stopped ? "stopped" : "current") : "waiting";
              return (
                <li key={stage.title} data-state={state} aria-current={state === "current" ? "step" : undefined}>
                  <span className={styles.stepNumber} aria-hidden="true">{state === "complete" ? "✓" : state === "stopped" ? "!" : `0${index + 1}`}</span>
                  <div><h3>{stage.title}</h3><p>{stage.detail}</p>
                    <span className={styles.stepState}>{state === "complete" ? "Complete" : state === "stopped" ? "Stopped" : state === "current" ? "Current step" : "Waiting"}</span>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
        <div className={styles.consoleGrid}>
          <section className={styles.changeCard} aria-labelledby="change-heading">
            <div className={styles.cardHeading}>
              <div><p className={styles.eyebrow}>Current change</p><h2 id="change-heading">{isRefund ? "Partial refund" : proposal ? "Change review" : "Ready for a proposal"}</h2></div>
              <span className={styles.statusBadge} data-tone={tone} role="status" aria-live="polite">{lifecycle.replaceAll("_", " ")}</span>
            </div>
            {proposal === null ? (
              <div className={styles.emptyState}>
                <span className={styles.emptyIcon} aria-hidden="true">＋</span>
                <h3>No change proposed yet</h3>
                <p>The agent can inspect the environment, propose a change, and request human review through WebMCP.</p>
                <span className={styles.emptyNote}>No approval · No execution authority</span>
              </div>
            ) : (
              <>
                <dl className={styles.changeSummary}>
                  <div><dt>{isRefund ? "Order" : "Target"}</dt><dd>{isRefund ? `#${proposal.target.split(":")[1]}` : proposal.target}</dd></div>
                  <div><dt>Action</dt><dd>{isRefund ? "Partial refund" : "Gateway change"}</dd></div>
                  {isRefund ? <>
                    <div className={styles.amount}><dt>Amount</dt><dd>{amount} <span>{String(proposal.parameters.currency)}</span></dd></div>
                    <div><dt>Policy limit</dt><dd>$30.00 <span>USD</span></dd><p>Fixed synthetic scenario</p></div>
                  </> : null}
                </dl>
                <details className={styles.proposalDetails}>
                  <summary>Exact immutable proposal <span>ID, digest & parameters</span></summary>
                  <dl>
                    <div><dt>Proposal ID</dt><dd><code>{proposal.proposalId}</code></dd></div>
                    <div><dt>Digest</dt><dd><code>{proposal.proposalDigest}</code></dd></div>
                    <div><dt>Target</dt><dd><code>{proposal.target}</code></dd></div>
                    <div><dt>Action</dt><dd><code>{proposal.action}</code></dd></div>
                    <div><dt>Parameters</dt><dd><code>{JSON.stringify(proposal.parameters)}</code></dd></div>
                    <div><dt>Preconditions</dt><dd>{proposal.preconditions.join(", ")}</dd></div>
                  </dl>
                </details>
              </>
            )}
            <section className={styles.decisionArea} data-tone={tone} aria-labelledby="decision-heading">
              <p className={styles.eyebrow}>Human decision · outside the agent tool surface</p>
              {proposal === null || proposal.lifecycle === "PROPOSED" ? (
                <><h3 id="decision-heading">Waiting for a review request</h3><p>Human controls become available when the agent requests approval of an exact proposal.</p></>
              ) : proposal.lifecycle === "AWAITING_HUMAN_APPROVAL" ? (
                <><h3 id="decision-heading">Human approval required</h3>
                  <p>Review the exact immutable proposal before granting authority. Approval does not execute.</p>
                  <div className={styles.decisionActions}>
                    <button className={styles.approveButton} type="button" onClick={() => operations.approvePendingChange()}>Approve exact proposal <span aria-hidden="true">→</span></button>
                    <button className={styles.rejectButton} type="button" onClick={() => operations.rejectPendingChange()}>Reject</button>
                  </div>
                </>
              ) : proposal.lifecycle === "APPROVED" ? (
                isRefund ? (
                  <><h3 id="decision-heading">Approved — execution still blocked</h3>
                    <p>Approval alone does not execute the refund. A separate human Execute decision is required.</p>
                    {pendingExecution !== null ? (
                      <div className={styles.decisionActions}>
                        <button className={styles.executeButton} type="button"
                          onClick={() => {
                            if (pendingExecution !== null) {
                              operations.executeApprovedRefund(pendingExecution);
                            }
                          }}
                        >Execute approved {amount} refund <span aria-hidden="true">→</span></button>
                      </div>
                    ) : <p>No valid execution identity is available. Execution is unavailable.</p>}
                  </>
                ) : <><h3 id="decision-heading">Authorization recorded</h3><p>Approved for authorization only. No change has executed.</p></>
              ) : proposal.lifecycle === "REJECTED" ? (
                <><h3 id="decision-heading">Proposal rejected</h3><p>This proposal has no execution authority.</p></>
              ) : proposal.lifecycle === "SUCCEEDED" ? (
                <><h3 id="decision-heading">Human decisions recorded</h3><p>The approval was consumed. This refund cannot be executed again.</p></>
              ) : proposal.lifecycle === "FAILED" ? (
                <><h3 id="decision-heading">Execution unavailable</h3><p>Approval is consumed; Execute is unavailable. Refund success is not verified.</p></>
              ) : (
                <><h3 id="decision-heading">No human action available</h3><p>Current lifecycle: {lifecycle.replaceAll("_", " ")}. Follow the verification status.</p></>
              )}
            </section>
          </section>
          <aside className={styles.sideColumn}>
            <section className={styles.verificationCard} data-tone={isRefund ? tone : "neutral"} aria-labelledby="verification-heading">
              <p className={styles.eyebrow}>Result assurance</p><h2 id="verification-heading">Verification</h2>
              <div className={styles.verificationStatus} role="status" aria-live="polite" aria-atomic="true">
                {isRefund && proposal.lifecycle === "SUCCEEDED" ? (
                  <><span className={styles.resultIcon} aria-hidden="true">✓</span><strong>VERIFIED</strong><p>Independent ledger readback matched the exact authorized refund.</p><span className={styles.resultNote}>Synthetic ledger · Exact match</span></>
                ) : isRefund && proposal.lifecycle === "FAILED" ? (
                  <><span className={styles.resultIcon} aria-hidden="true">!</span><strong>FAILED CLOSED</strong><p>A failed result does not prove no ledger write occurred.</p><span className={styles.resultNote}>Success unverified · No rollback claimed</span></>
                ) : isRefund && proposal.lifecycle === "EXECUTING" ? (
                  <><span className={styles.resultIcon} aria-hidden="true">→</span><strong>Execution in progress</strong><p>Executing the exact approved refund in the synthetic ledger.</p></>
                ) : isRefund && proposal.lifecycle === "VERIFYING" ? (
                  <><span className={styles.resultIcon} aria-hidden="true">◎</span><strong>Independent readback</strong><p>Checking synthetic ledger against the exact authorized refund.</p></>
                ) : (
                  <><span className={styles.resultIcon} aria-hidden="true">○</span><strong>Waiting for execution</strong><p>Success requires an independent ledger readback. Approval alone is not proof.</p></>
                )}
              </div>
            </section>
            <section className={styles.boundaryCard} aria-labelledby="boundary-heading">
              <div className={styles.cardHeading}><h2 id="boundary-heading">WebMCP boundary</h2><span className={styles.toolBadge}>7 tools</span></div>
              <p><strong>Agent</strong><span>Inspect · Propose · Request review</span></p>
              <p><strong>Human only</strong><span>Approve / Reject · Execute refund</span></p>
              <div className={styles.boundaryNote}>Refund execution requires a second human decision. Gateway execution is unavailable.</div>
            </section>
          </aside>
        </div>
        <section className={styles.auditPanel} aria-labelledby="audit-heading">
          <div className={styles.cardHeading}><div><p className={styles.eyebrow}>Decision & execution record</p><h2 id="audit-heading">Audit trail</h2></div><span className={styles.eventCount}>{audit.totalEvents} events</span></div>
          {audit.events.length === 0 ? <p className={styles.auditEmpty}>No audit events yet. The chain begins when the agent proposes a change.</p> : (
            <ol className={styles.auditChain}>
              {audit.events.map((event) => (
                <li key={event.sequence}>
                  <span className={styles.sequence} aria-label={`Sequence ${event.sequence}`}>{String(event.sequence).padStart(2, "0")}</span>
                  <span className={styles.actor} data-actor={event.actor}>{event.actor === "AGENT" ? "AI / AGENT" : event.actor}</span>
                  <code>{event.type}</code>
                  <span className={styles.auditLifecycle}>{event.lifecycle.replaceAll("_", " ")}</span>
                </li>
              ))}
            </ol>
          )}
          {audit.truncated ? <p className={styles.auditEmpty}>Showing the latest {audit.events.length} of {audit.totalEvents} events.</p> : null}
        </section>
      </div>
    </>
  );
}
