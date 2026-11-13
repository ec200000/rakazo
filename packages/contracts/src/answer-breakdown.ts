import { z } from "zod";

const Ms = z.number().int().nonnegative();
const Tokens = z.number().int().nonnegative().nullable();

/**
 * Where one answer's time went, and how full the model's context was on its last call. Every
 * part is measured, except `otherMs`: the rest of the answer's time, which is Rakazo itself
 * preparing each model call, saving progress and starting things.
 */
export const AnswerBreakdownSchema = z.object({
  totalMs: Ms,
  /** Waiting for a free worker before the run started. */
  queuedMs: Ms,
  /** Waiting for the person: an approval card or a question. */
  waitingMs: Ms,
  /** The bot's own model calls; null when its calls were not timed (older answers). */
  modelMs: Ms.nullable(),
  toolsMs: Ms,
  otherMs: Ms,
  model: z.string().nullable(),
  modelCalls: z.number().int().nonnegative(),
  /** Average time from sending a model call to its first output: mostly reading the prompt. */
  firstTokenMs: Ms.nullable(),
  /** Model calls made for checks around the answer, like automatic review of risky actions. */
  reviewCalls: z.number().int().nonnegative(),
  reviewMs: Ms.nullable(),
  /** Model calls made by helper agents; their time is part of the helper tool's time. */
  helperCalls: z.number().int().nonnegative(),
  tokens: z.object({
    /** Prompt tokens across the bot's calls, including the part the server reused from cache. */
    input: Tokens,
    /** The part of `input` the model server reused instead of reading again. */
    cached: Tokens,
    output: Tokens,
    reasoning: Tokens,
  }),
  /** The slowest tools, by total time. */
  tools: z
    .array(
      z.object({
        name: z.string(),
        count: z.number().int().positive(),
        ms: Ms,
      }),
    )
    .max(8),
  /** The prompt size of the bot's last model call, against the model's context window. */
  context: z
    .object({
      usedTokens: z.number().int().nonnegative(),
      windowTokens: z.number().int().positive().nullable(),
    })
    .nullable(),
});
export type AnswerBreakdown = z.infer<typeof AnswerBreakdownSchema>;
