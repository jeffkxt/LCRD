/**
 * Model-facing notice builders: the LCRD producer source stamp and the
 * text-block helper shared by every rollback, termination, and interception
 * decision. Pure — no plugin state, so tools and step handlers can import it
 * without a cycle back into the wiring root.
 */
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, PreToolDecision } from '@deepseek-ai/dsh-tools'

/** The LCRD producer source stamp on every injected context; concrete so spreads do not widen to the MessageSource union. */
export const PLUGIN_SOURCE = { kind: 'lcrd-hard-isolation' as const }

/**
 * The high-visibility line for one policy lifecycle transition.
 * @param action - whether the active version was promoted or rolled back.
 * @param from - the version that was active.
 * @param to - the version now active.
 * @param reason - the gate, approval, or regression reason.
 * @returns the single-line system notice.
 */
export function policyNoticeText(
  action: 'promoted' | 'rolled-back',
  from: string,
  to: string,
  reason: string,
): string {
  const verb = action === 'promoted' ? 'Promoted' : 'Rolled Back'
  return `[SYSTEM NOTICE] LCRD Policy ${verb}: ${from} -> ${to} (Reason: ${reason}). Active policy switched.`
}

/**
 * The model-facing notice for one policy lifecycle transition, delivered
 * through the existing `additionalContexts` channel on the next tool decision.
 * @param action - whether the active version was promoted or rolled back.
 * @param from - the version that was active.
 * @param to - the version now active.
 * @param reason - the gate, approval, or regression reason.
 * @returns the notice message stamped with the LCRD producer source.
 */
export function policyNotice(
  action: 'promoted' | 'rolled-back',
  from: string,
  to: string,
  reason: string,
): UserMessage {
  return createUserMessage({
    content: [textBlock(policyNoticeText(action, from, to, reason))],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary: `policy ${action}: ${from} -> ${to}` },
  })
}

/** Model-facing text of one content block.
 * @param text - the text content of the block.
 * @returns the typed text content block.
 */
export function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

/**
 * A `block` decision whose feedback alone reaches the model (no separate
 * notice context) — used when the terminal or interception message is short
 * and needs no durable echo beyond the tool result.
 * @param feedback - the corrective text the model sees as the tool result.
 * @returns the block decision.
 */
export function blockFeedback(feedback: string): PostToolDecision {
  return { kind: 'block', feedback: [textBlock(feedback)] }
}

/**
 * A `block` decision with corrective feedback plus a durable plugin notice —
 * the notice is a separate user-shaped message so long sessions retain the
 * interception even after the tool result scrolls out of the window.
 * @param feedback - the corrective text the model sees as the tool result.
 * @param notice - the durable notice text (often the same as `feedback`).
 * @param summary - the short notice summary recorded on the source.
 * @returns the block decision with its additional context.
 */
export function blockNotice(feedback: string, notice: string, summary: string): PostToolDecision {
  return {
    kind: 'block',
    feedback: [textBlock(feedback)],
    additionalContexts: [createUserMessage({
      content: [textBlock(notice)],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary },
    })],
  }
}

/**
 * An `accept` decision that keeps the tool result and attaches one durable
 * plugin notice. Used where the result must reach the model unchanged but the
 * observation still has to persist beyond the tool result.
 * @param notice - the durable notice text.
 * @param summary - the short notice summary recorded on the source.
 * @returns the accept decision carrying the additional context.
 */
export function acceptNotice(notice: string, summary: string): PostToolDecision {
  return {
    kind: 'accept',
    additionalContexts: [createUserMessage({
      content: [textBlock(notice)],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary },
    })],
  }
}

/**
 * A `deny` decision for the file-flow guard: the reason is the only text the
 * model sees, and no verifier retry is consumed.
 * @param reason - why the path or tool was denied.
 * @returns the deny decision.
 */
export function denyDecision(reason: string): PreToolDecision {
  return { kind: 'deny', reason }
}
