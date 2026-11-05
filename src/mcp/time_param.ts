import { z } from "zod";

import { TIME_INPUT_HINT, utcBound } from "../util/time.js";

/** A tool's time input: the handler receives it as UTC ISO; an unreadable one fails the parse. */
export const timeParam: z.ZodType<string> = z
  .string()
  .refine((s) => utcBound(s) !== null, { message: TIME_INPUT_HINT })
  .transform((s) => utcBound(s)!);
