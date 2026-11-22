import { randomUUID } from "node:crypto";
import {
  cents, MerchantError, RefundNotSubmitted, RefundSubmissionRejected, type CaptureSnapshot, type CaseStatus, type MerchantCapture,
  type MerchantEnvironment, type MerchantProvider, type RefundObservation,
} from "./contracts";
import { MerchantStore, type CaseRow } from "./store";

const activeAttempt = (status: CaseStatus) => ["SUBMITTED", "PENDING", "UNCERTAIN"].includes(status);

export class MerchantRefunds {
  constructor(
    readonly store: MerchantStore,
    private readonly provider: MerchantProvider,
    readonly environment: MerchantEnvironment,
    readonly maxRefundCents: number,
    private readonly now = () => new Date().toISOString(),
  ) {}

  private async captures(kind: "order" | "capture", reference: string) {
    const captures = await this.provider.find(kind, reference);
    if (!captures.length || captures.some((row) => row.merchantId !== this.store.merchantId ||
      (kind === "capture" ? row.captureId : row.orderId) !== reference)) {
      throw new MerchantError("MERCHANT_CAPTURE_NOT_FOUND", 404);
    }
    return captures;
  }

  private async capture(id: string) {
    const result = await this.captures("capture", id);
    if (result.length !== 1 || !result[0]) throw new MerchantError("AMBIGUOUS_CAPTURE");
    return result[0];
  }

  private balance(capture: CaptureSnapshot): MerchantCapture {
    const attempts = this.store.attempts(capture.captureId);
    const accounted = new Map<string, RefundObservation>();
    for (const refund of capture.refunds) {
      if (refund.status === "COMPLETED" || refund.status === "PENDING") accounted.set(refund.refundId, refund);
    }
    const boundIds = new Set(attempts.map(({ refund_id }) => refund_id));
    let used = [...accounted.values()].reduce((sum, { amountCents }) => sum + amountCents, 0);
    for (const attempt of attempts) {
      if (!activeAttempt(attempt.status) && attempt.status !== "COMPLETED") continue;
      const invoice = "changegate-" + attempt.request_id;
      let observed: RefundObservation | undefined;
      if (attempt.refund_id) {
        const bound = accounted.get(attempt.refund_id);
        const independentlyMatched = attempt.status === "PENDING" || attempt.status === "COMPLETED";
        if (bound && (bound.invoiceId === invoice || (bound.invoiceId === null && independentlyMatched))) observed = bound;
      } else if (attempt.request_id) {
        const matches = capture.refunds.filter(({ invoiceId }) => invoiceId === invoice);
        const match = matches.length === 1 ? matches[0] : undefined;
        if (match && !boundIds.has(match.refundId)) observed = accounted.get(match.refundId);
      }
      // Overlap requires the same attempt and effect. Keep the full hold if either is in doubt.
      if (!observed || observed.captureId !== attempt.capture_id || observed.amountCents !== attempt.amount_cents ||
          observed.currency !== attempt.currency) used += attempt.amount_cents;
    }
    const historyComplete = capture.historyComplete && capture.currency === "USD";
    return {
      orderId: capture.orderId, captureId: capture.captureId, amountCents: capture.amountCents,
      currency: capture.currency, status: capture.status, historyComplete,
      refunds: capture.refunds.map(({ refundId, captureId, amountCents, currency, status, observedAt }) =>
        ({ refundId, captureId, amountCents, currency, status, observedAt })),
      outstanding: attempts.filter(({ status }) => activeAttempt(status))
        .map(({ id, amount_cents, status, refund_id }) => ({ id, amountCents: amount_cents, status, refundId: refund_id })),
      remainingCents: historyComplete ? Math.max(0, capture.amountCents - used) : null,
    };
  }

  async find(kind: "order" | "capture", reference: string) {
    return (await this.captures(kind, reference)).map((item) => this.balance(item));
  }

  private eligible(capture: CaptureSnapshot, amount: number | null): number {
    if (capture.currency !== "USD") throw new MerchantError("USD_CAPTURE_REQUIRED");
    if (!["COMPLETED", "PARTIALLY_REFUNDED"].includes(capture.status)) throw new MerchantError("CAPTURE_NOT_REFUNDABLE");
    const balance = this.balance(capture).remainingCents;
    if (balance === null) throw new MerchantError("REFUND_HISTORY_UNCERTAIN");
    const requested = amount ?? balance;
    if (!cents.safeParse(requested).success || requested > balance) throw new MerchantError("REFUND_EXCEEDS_REMAINING_BALANCE");
    if (requested > this.maxRefundCents) throw new MerchantError("REFUND_POLICY_LIMIT");
    return requested;
  }

  async propose(captureId: string, amount: number | null, actor: string) {
    const capture = await this.capture(captureId);
    return this.store.atomic(() => {
      const amountCents = this.eligible(capture, amount);
      const id = randomUUID();
      this.store.db.prepare(`
        INSERT INTO merchant_cases(id, merchant_id, order_id, capture_id, amount_cents, currency, version, status)
        VALUES (?, ?, ?, ?, ?, 'USD', 1, 'PROPOSED')
      `).run(id, this.store.merchantId, capture.orderId, captureId, amountCents);
      this.store.event(id, actor, "PROPOSE_CHANGE", "PROPOSED", this.now());
      return this.store.detail(id);
    });
  }

  private requireVersion(row: CaseRow, version: number, state: CaseStatus) {
    if (row.version !== version || row.status !== state) throw new MerchantError("CASE_CHANGED_OR_ACTION_UNAVAILABLE");
  }

  review(id: string, version: number, actor: string) {
    return this.store.atomic(() => {
      this.requireVersion(this.store.get(id), version, "PROPOSED");
      this.store.db.prepare("UPDATE merchant_cases SET status='REVIEW' WHERE id=?").run(id);
      this.store.event(id, actor, "REQUEST_HUMAN_APPROVAL", "REVIEW", this.now());
      return this.store.detail(id);
    });
  }

  decide(id: string, version: number, decision: "approve" | "reject", actor: string) {
    return this.store.atomic(() => {
      this.requireVersion(this.store.get(id), version, "REVIEW");
      const state = decision === "approve" ? "APPROVED" : "REJECTED";
      const at = this.now();
      this.store.db.prepare("UPDATE merchant_cases SET status=?, decision=?, reviewer=?, decision_at=? WHERE id=?")
        .run(state, state, actor, at, id);
      this.store.event(id, actor, decision === "approve" ? "HUMAN_APPROVE" : "HUMAN_REJECT", state, at);
      return this.store.detail(id);
    });
  }

  async execute(id: string, version: number, actor: string) {
    const before = this.store.get(id);
    this.requireVersion(before, version, "APPROVED");
    const capture = await this.capture(before.capture_id);
    // A committed reservation, approval consumption and request ID precede the first possible POST.
    const attempt = this.store.atomic(() => {
      const row = this.store.get(id);
      this.requireVersion(row, version, "APPROVED");
      if (row.order_id !== capture.orderId || row.decision !== "APPROVED" || !row.reviewer || row.request_id) {
        throw new MerchantError("APPROVAL_BINDING_MISMATCH");
      }
      this.eligible(capture, row.amount_cents);
      const requestId = randomUUID();
      const at = this.now();
      this.store.db.prepare(`
        UPDATE merchant_cases SET status='SUBMITTED', request_id=?, submitted_at=?, issue='AWAITING_PROVIDER_EVIDENCE' WHERE id=?
      `).run(requestId, at, id);
      this.store.event(id, actor, "HUMAN_EXECUTE_ATTEMPT_RESERVED", "SUBMITTED", at);
      return { requestId, captureId: row.capture_id, amountCents: row.amount_cents };
    });
    let refundId: string;
    try {
      refundId = await this.provider.submit(attempt.captureId, attempt.amountCents, attempt.requestId);
    } catch (error) {
      if (error instanceof RefundNotSubmitted || error instanceof RefundSubmissionRejected) {
        const issue = error instanceof RefundNotSubmitted ? "REFUND_NOT_SUBMITTED" : "REFUND_SUBMISSION_REJECTED";
        this.store.atomic(() => {
          const current = this.store.get(id);
          if (activeAttempt(current.status) && !current.refund_id && !current.observation) {
            this.store.db.prepare("UPDATE merchant_cases SET status='FAILED', issue=? WHERE id=?").run(issue, id);
            this.store.event(id, "SYSTEM", issue, "FAILED", this.now());
          }
        });
      } else {
        this.markEvidenceUnavailable(id, "SUBMISSION_RESPONSE_UNAVAILABLE");
      }
      return this.store.detail(id);
    }
    this.store.atomic(() => {
      const current = this.store.get(id);
      if (!activeAttempt(current.status)) return;
      if (current.refund_id && current.refund_id !== refundId) {
        this.recordUncertain(id, "PROVIDER_REFUND_ID_CONFLICT");
        return;
      }
      const duplicate = this.store.db.prepare("SELECT 1 FROM merchant_cases WHERE refund_id=? AND id<>?").get(refundId, id);
      if (duplicate) {
        this.recordUncertain(id, "PROVIDER_REFUND_ID_CONFLICT");
        return;
      }
      if (current.refund_id) return;
      this.store.db.prepare("UPDATE merchant_cases SET refund_id=? WHERE id=?").run(refundId, id);
      this.store.event(id, "SYSTEM", "PROVIDER_REFUND_ID_RECORDED", current.status, this.now());
    });
    const current = this.store.get(id);
    return activeAttempt(current.status) && current.refund_id === refundId ? this.reconcile(id) : this.store.detail(id);
  }

  private recordUncertain(id: string, issue: string) {
    this.store.db.prepare("UPDATE merchant_cases SET status='UNCERTAIN', issue=? WHERE id=?").run(issue, id);
    this.store.event(id, "SYSTEM", issue, "UNCERTAIN", this.now());
  }

  private markEvidenceUnavailable(id: string, issue: string) {
    this.store.atomic(() => {
      const row = this.store.get(id);
      if (!activeAttempt(row.status)) return;
      if (row.status === "PENDING") {
        // A missing response does not supersede an independently observed pending refund.
        this.store.db.prepare("UPDATE merchant_cases SET issue=? WHERE id=?").run(issue, id);
        this.store.event(id, "SYSTEM", issue, "PENDING", this.now());
        return;
      }
      this.recordUncertain(id, issue);
    });
  }

  async reconcile(id: string, candidateRefundId?: string) {
    const row = this.store.get(id);
    if (!activeAttempt(row.status) || !row.request_id) throw new MerchantError("RECONCILIATION_UNAVAILABLE");
    if (row.refund_id && candidateRefundId && row.refund_id !== candidateRefundId) {
      throw new MerchantError("REFUND_REFERENCE_ALREADY_BOUND");
    }
    const expectedInvoice = "changegate-" + row.request_id;
    let evidence: RefundObservation;
    try {
      const refundId = row.refund_id ?? candidateRefundId;
      if (refundId) {
        // An explicit reference needs ownership and one independent refund GET, not a history scan.
        await this.provider.assertCaptureOwnership(row.capture_id, row.order_id);
        evidence = await this.provider.readRefund(refundId);
        if (refundId !== evidence.refundId) throw new MerchantError("REFUND_IDENTITY_MISMATCH");
      } else {
        const capture = await this.capture(row.capture_id);
        if (capture.orderId !== row.order_id) throw new MerchantError("CAPTURE_ORDER_MISMATCH");
        const discovered = capture.refunds.filter(({ invoiceId }) => invoiceId === expectedInvoice);
        if (discovered.length !== 1 || !discovered[0]) {
          this.markEvidenceUnavailable(id, discovered.length > 1 ? "MULTIPLE_PROVIDER_REFUNDS_MATCH_ATTEMPT" : "ORIGINAL_REFUND_NOT_LOCATED");
          return this.store.detail(id);
        }
        // The history lookup has already independently fetched this refund by its provider ID.
        evidence = discovered[0];
      }
    } catch {
      this.markEvidenceUnavailable(id, "INDEPENDENT_READBACK_UNAVAILABLE");
      return this.store.detail(id);
    }

    return this.store.atomic(() => {
      const current = this.store.get(id);
      if (!activeAttempt(current.status)) return this.store.detail(id);
      const sameAttempt = current.refund_id
        ? evidence.refundId === current.refund_id && (evidence.invoiceId === null || evidence.invoiceId === expectedInvoice)
        : evidence.invoiceId === expectedInvoice;
      const sameEffect = evidence.captureId === current.capture_id && evidence.amountCents === current.amount_cents &&
        evidence.currency === current.currency;
      const duplicate = this.store.db.prepare("SELECT 1 FROM merchant_cases WHERE refund_id=? AND id<>?").get(evidence.refundId, id);
      const verified = sameAttempt && sameEffect && !duplicate;
      const state = !verified ? "UNCERTAIN"
        : evidence.status === "COMPLETED" ? "COMPLETED" : evidence.status === "PENDING" ? "PENDING" : "FAILED";
      // Evidence for another capture or invoice does not belong in this case or receipt.
      const observation = sameAttempt && evidence.captureId === current.capture_id && !duplicate
        ? JSON.stringify({
            refundId: evidence.refundId, captureId: evidence.captureId, amountCents: evidence.amountCents,
            currency: evidence.currency, status: evidence.status, observedAt: evidence.observedAt,
          })
        : current.observation;
      const issue = !verified ? "REFUND_READBACK_MISMATCH" : state === "FAILED" ? "PROVIDER_REFUND_FAILED" : null;
      this.store.db.prepare("UPDATE merchant_cases SET status=?, refund_id=?, observation=?, issue=? WHERE id=?")
        .run(state, verified ? evidence.refundId : current.refund_id, observation, issue, id);
      this.store.event(id, "SYSTEM", issue ?? "INDEPENDENT_REFUND_READBACK", state, this.now());
      return this.store.detail(id);
    });
  }
}
