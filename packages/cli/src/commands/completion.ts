import { GLOBAL_OPTIONS, type OptionDefs } from "../args.js";
import type { CommandSpec } from "../command.js";
import { UsageError } from "../errors.js";

type Shell = "bash" | "zsh" | "fish";

function flags(options: OptionDefs): string[] {
  return Object.entries(options).flatMap(([name, def]) => [
    `--${name}`,
    ...(def.short ? [`-${def.short}`] : []),
  ]);
}

function words(items: readonly string[]): string {
  for (const item of items) {
    if (!/^[a-z0-9][a-z0-9-]*$|^--?[a-z0-9][a-z0-9-]*$/.test(item))
      throw new Error(`unsafe completion word: ${item}`);
  }
  return items.join(" ");
}

function guidePosition(command: CommandSpec): number {
  return command.positionals.findIndex((p) => p.name === "explainer");
}

function bash(commands: readonly CommandSpec[]): string {
  const names = words(commands.map((c) => c.name));
  const cases = commands
    .map((c) => {
      const opts = words(flags({ ...GLOBAL_OPTIONS, ...c.options }));
      const values = words(
        Object.entries({ ...GLOBAL_OPTIONS, ...c.options })
          .filter(([, def]) => def.type === "string")
          .flatMap(([name, def]) => [`--${name}`, ...(def.short ? [`-${def.short}`] : [])]),
      );
      return `    ${c.name}) opts='${opts}'; value_opts='${values}'; guide_at=${guidePosition(c)} ;;`;
    })
    .join("\n");
  return `# Source with: source <(xpl completion bash)
_xpl_completion() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd="\${COMP_WORDS[1]}" opts='' value_opts='' guide_at=-1
  local i word skip=0 position=0 file name
  COMPREPLY=()
  if (( COMP_CWORD == 1 )); then
    COMPREPLY=( $(compgen -W '${names}' -- "$cur") )
    return
  fi
  case "$cmd" in
${cases}
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
    return
  fi
  for ((i=2; i<COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    if (( skip )); then skip=0; continue; fi
    case "$word" in
      --*=*) continue ;;
    esac
    case " $value_opts " in
      *" $word "*) skip=1; continue ;;
    esac
    [[ "$word" == -* ]] || ((position+=1))
  done
  (( skip || position != guide_at )) && return
  for file in .explainer/*.explainer.json; do
    [[ -f "$file" ]] || continue
    name="\${file##*/}"
    name="\${name%.explainer.json}"
    [[ "$name" == "$cur"* ]] && COMPREPLY+=("$name")
  done
}
complete -F _xpl_completion xpl`;
}

function zsh(commands: readonly CommandSpec[]): string {
  const names = words(commands.map((c) => c.name));
  const cases = commands
    .map(
      (c) =>
        `    ${c.name}) opts=(${words(flags({ ...GLOBAL_OPTIONS, ...c.options }))}); guide_at=${guidePosition(c)} ;;`,
    )
    .join("\n");
  return `# Source after compinit: source <(xpl completion zsh)
_xpl_completion() {
  local cur="$words[CURRENT]" cmd="$words[2]" guide_at=-1 file name
  local -a opts
  if (( CURRENT == 2 )); then
    compadd -- ${names}
    return
  fi
  case "$cmd" in
${cases}
  esac
  if [[ "$cur" == -* ]]; then
    compadd -- "\${opts[@]}"
    return
  fi
  (( CURRENT != guide_at + 3 )) && return
  for file in .explainer/*.explainer.json(N); do
    name="\${file:t}"
    name="\${name%.explainer.json}"
    compadd -- "$name"
  done
}
compdef _xpl_completion xpl`;
}

function fish(commands: readonly CommandSpec[]): string {
  const lines = [
    "# Save with: xpl completion fish > ~/.config/fish/completions/xpl.fish",
    "function __xpl_guide_names",
    "    for file in .explainer/*.explainer.json",
    '        test -f "$file"; or continue',
    "        string replace -r '\\.explainer\\.json$' '' -- (string replace -r '^.*/' '' -- \"$file\")",
    "    end",
    "end",
    "complete -c xpl -f",
    `complete -c xpl -n '__fish_use_subcommand' -a '${words(commands.map((c) => c.name))}'`,
  ];
  for (const [name, def] of Object.entries(GLOBAL_OPTIONS)) {
    lines.push(
      `complete -c xpl -l ${name}${def.short ? ` -s ${def.short}` : ""}${def.type === "string" ? " -r" : ""}`,
    );
  }
  for (const command of commands) {
    for (const [name, def] of Object.entries(command.options)) {
      lines.push(
        `complete -c xpl -n '__fish_seen_subcommand_from ${command.name}' -l ${name}${def.short ? ` -s ${def.short}` : ""}${def.type === "string" ? " -r" : ""}`,
      );
    }
    if (guidePosition(command) >= 0)
      lines.push(
        `complete -c xpl -n '__fish_seen_subcommand_from ${command.name}' -a '(__xpl_guide_names)'`,
      );
  }
  return lines.join("\n");
}

/** The command table is supplied by cli.ts so completion and help use the same rows. */
export function completionCommand(commands: () => readonly CommandSpec[]): CommandSpec {
  return {
    name: "completion",
    usage: "xpl completion <bash|zsh|fish>",
    summary: "Print shell completion for commands, options and local guides",
    details: [
      "Source the bash or zsh output in your shell startup file. For fish, save it under",
      "~/.config/fish/completions/xpl.fish. Guide names come from .explainer/*.explainer.json",
      "in the current directory when you complete an <explainer> argument.",
    ],
    options: {},
    positionals: [{ name: "shell" }],
    async run(ctx, args) {
      const shell = args.positionals[0];
      if (shell !== "bash" && shell !== "zsh" && shell !== "fish")
        throw new UsageError("<shell> must be bash, zsh, or fish");
      const script = ({ bash, zsh, fish } satisfies Record<Shell, typeof bash>)[shell](commands());
      if (ctx.json) ctx.emit({ shell, script });
      else ctx.out(script);
      return 0;
    },
  };
}
