import { z } from "zod";

// App-owned grammar: feedback can select these rules, never write executable policy.
export const ruleId = z.enum(["NO_HASHTAGS", "NO_EMOJI", "SHORT_CAPTION"]);
export type RuleId = z.infer<typeof ruleId>;
export const learnedRule = z.object({ id: ruleId, channel: z.enum(["Instagram", "Facebook", "LinkedIn", "X"]) }).strict();
export const ruleInstructions: Record<RuleId, string> = {
  NO_HASHTAGS: "Do not include hashtags in headlines, captions or calls to action.",
  NO_EMOJI: "Do not include emoji in headlines, captions or calls to action.",
  SHORT_CAPTION: "Keep the complete publishable caption to at most 80 whitespace-separated words.",
};
export function requestedRules(feedback: string): RuleId[] {
  const clauses = feedback.toLowerCase().split(/[.!?;\n]+/).map(s => s.trim().replace(/^please\s+/, ""));
  const has = (re: RegExp) => clauses.some(s => re.test(s));
  return [
    ...(has(/^(?:no hashtags|(?:remove|avoid|omit) (?:all |the )?hashtags|do not (?:use|include) hashtags)$/) ? ["NO_HASHTAGS" as const] : []),
    ...(has(/^(?:no emojis?|(?:remove|avoid|omit) (?:all |the )?emojis?|do not (?:use|include) emojis?)$/) ? ["NO_EMOJI" as const] : []),
    ...(has(/^(?:shorter captions?|keep (?:the )?caption (?:short|under 80 words)|(?:use|write) shorter captions?)$/) ? ["SHORT_CAPTION" as const] : []),
  ];
}
export function followsRule(id: RuleId, content: { headline: string; caption: string; cta: string }) {
  const text = `${content.headline}\n${content.caption}\n${content.cta}`;
  if (id === "NO_HASHTAGS") return !/(?:^|\s)#[\p{L}\p{N}_]+/u.test(text);
  if (id === "NO_EMOJI") return !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(text);
  return content.caption.trim().split(/\s+/u).filter(Boolean).length <= 80;
}
export const ruleText = (id: RuleId, channel: string) => `Learned copy skill [${channel}] ${id}: ${ruleInstructions[id]}`;
export function rulesFromMemories(memories: { kind: string; text: string }[], channel: string) {
  return ruleId.options.filter(id => memories.some(m => m.kind === "APPROVED_SKILL" && m.text === ruleText(id, channel))).map(id => learnedRule.parse({ id, channel }));
}
