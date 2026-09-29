import type { Args, OptionDefs, PositionalSpec } from "./args.js";
import type { Ctx } from "./context.js";

/** One row of the command table in ARCHITECTURE.md §5, plus how to run it. */
export interface CommandSpec {
  name: string;
  /** The usage line, e.g. `xpl show <id> [--refs] [--context n]`. */
  usage: string;
  /** One line for the command list. */
  summary: string;
  /** Paragraphs for `xpl <command> --help`. */
  details?: string[];
  /** Command-specific options (the global ones are added). */
  options: OptionDefs;
  positionals: PositionalSpec[];
  /** Resolves to the exit code: 0 ok, 1 rejected or failed. Usage errors are thrown. */
  run(ctx: Ctx, args: Args): Promise<number>;
}
