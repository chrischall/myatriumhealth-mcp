/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`, the context-groups contract). Inert data: a host that does
 * not read them sees an extra `_meta` key and nothing else. The shape is fixed
 * by the host's contract, so it is restated here rather than imported — this
 * server takes no dependency on mcp-host.
 *
 * No hint here names a `subject`. The patients this login can open ARE
 * listable (mah_list_patients), but no read takes a patient argument: the
 * active patient lives inside the portal session and is changed with
 * mah_set_active_patient, a write (see PatientContext). A subject the host
 * fanned out over would have to switch the session per value — through the
 * browser bridge, the person's own tab — so the reads stay bound to the
 * active patient and the group asks them without one.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'health';
  intent: MintIntent;
  canonical?: true;
  when?: { start: string; end: string };
  /** What a person says, not tool names: ≤ 8, lowercase, each ≤ 40 chars. */
  aliases?: string[];
}

/** `_meta` for a MyAtriumHealth tool: every tool here is in the `health` domain. */
export function healthMeta(
  intent: MintIntent,
  extra: Omit<MintHint, 'domain' | 'intent'> = {},
): { mint: MintHint } {
  return { mint: { domain: 'health', intent, ...extra } };
}
