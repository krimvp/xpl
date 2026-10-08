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

function valueFlags(options: OptionDefs): string[] {
  return Object.entries(options)
    .filter(([, def]) => def.type === "string")
    .flatMap(([name, def]) => [`--${name}`, ...(def.short ? [`-${def.short}`] : [])]);
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
  const globalFlags = words(flags(GLOBAL_OPTIONS));
  const cases = commands
    .map((c) => {
      const opts = words(flags({ ...GLOBAL_OPTIONS, ...c.options }));
      const values = words(valueFlags({ ...GLOBAL_OPTIONS, ...c.options }));
      return `    ${c.name}) opts='${opts}'; value_opts='${values}'; guide_at=${guidePosition(c)} ;;`;
    })
    .join("\n");
  return `# Source with: source <(xpl completion bash)
_xpl_completion() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd='' cmd_index=0 root='.' opts='' value_opts='' guide_at=-1
  local i word skip=0 position=0 file name
  COMPREPLY=()
  for ((i=1; i<COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    if (( skip )); then skip=0; continue; fi
    case "$word" in
      --root=*) root="\${word#--root=}"; continue ;;
      --root) root="\${COMP_WORDS[i+1]}"; skip=1; continue ;;
      --index) skip=1; continue ;;
      -*) continue ;;
      *) cmd="$word"; cmd_index=$i; break ;;
    esac
  done
  if [[ -z "$cmd" ]]; then
    (( skip )) && return
    if [[ "$cur" == -* ]]; then opts='${globalFlags}'; else opts='${names}'; fi
    COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
    return
  fi
  case "$cmd" in
${cases}
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
    return
  fi
  for ((i=cmd_index+1; i<COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    if (( skip )); then skip=0; continue; fi
    case "$word" in
      --root=*) root="\${word#--root=}"; continue ;;
      --root) root="\${COMP_WORDS[i+1]}"; skip=1; continue ;;
      --*=*) continue ;;
    esac
    case " $value_opts " in
      *" $word "*) skip=1; continue ;;
    esac
    [[ "$word" == -* ]] || ((position+=1))
  done
  (( skip || position != guide_at )) && return
  for file in "$root"/.explainer/*.explainer.json; do
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
  const globalFlags = words(flags(GLOBAL_OPTIONS));
  const cases = commands
    .map(
      (c) =>
        `    ${c.name}) opts=(${words(flags({ ...GLOBAL_OPTIONS, ...c.options }))}); value_opts=(${words(valueFlags({ ...GLOBAL_OPTIONS, ...c.options }))}); guide_at=${guidePosition(c)} ;;`,
    )
    .join("\n");
  return `# Source after compinit: source <(xpl completion zsh)
_xpl_completion() {
  local cur="$words[CURRENT]" cmd='' cmd_index=0 root='.' guide_at=-1 file name
  local i word value skip=0 position=0
  local -a opts value_opts
  for ((i=2; i<CURRENT; i++)); do
    word="$words[i]"
    if (( skip )); then skip=0; continue; fi
    case "$word" in
      --root=*) root="\${word#--root=}"; continue ;;
      --root) root="$words[i+1]"; skip=1; continue ;;
      --index) skip=1; continue ;;
      -*) continue ;;
      *) cmd="$word"; cmd_index=$i; break ;;
    esac
  done
  if [[ -z "$cmd" ]]; then
    (( skip )) && return
    if [[ "$cur" == -* ]]; then compadd -- ${globalFlags}; else compadd -- ${names}; fi
    return
  fi
  case "$cmd" in
${cases}
  esac
  if [[ "$cur" == -* ]]; then
    compadd -- "\${opts[@]}"
    return
  fi
  for ((i=cmd_index+1; i<CURRENT; i++)); do
    word="$words[i]"
    if (( skip )); then skip=0; continue; fi
    case "$word" in
      --root=*) root="\${word#--root=}"; continue ;;
      --root) root="$words[i+1]"; skip=1; continue ;;
      --*=*) continue ;;
    esac
    for value in $value_opts; do
      if [[ "$word" == "$value" ]]; then skip=1; break; fi
    done
    if (( skip )); then continue; fi
    [[ "$word" == -* ]] || ((position+=1))
  done
  (( skip || position != guide_at )) && return
  for file in "$root"/.explainer/*.explainer.json(N); do
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
    "function __xpl_before_command",
    "    set -l tokens (commandline -opc)",
    "    set -l skip 0",
    "    for token in $tokens[2..-1]",
    "        if test $skip -eq 1",
    "            set skip 0",
    "            continue",
    "        end",
    '        if contains -- "$token" --root --index',
    "            set skip 1",
    "            continue",
    "        end",
    "        string match -q -- '-*' \"$token\"; and continue",
    "        return 1",
    "    end",
    "    test $skip -eq 0",
    "end",
    "function __xpl_guide_at --argument-names command target",
    "    set -l value_opts $argv[3..-1]",
    "    set -l tokens (commandline -opc)",
    "    set -l skip 0",
    "    set -l seen 0",
    "    set -l position 0",
    "    for token in $tokens[2..-1]",
    "        if test $skip -eq 1",
    "            set skip 0",
    "            continue",
    "        end",
    "        if test $seen -eq 0",
    '            if contains -- "$token" --root --index',
    "                set skip 1",
    "                continue",
    "            end",
    "            string match -q -- '-*' \"$token\"; and continue",
    '            test "$token" = "$command"; or return 1',
    "            set seen 1",
    "            continue",
    "        end",
    "        string match -q -- '--*=*' \"$token\"; and continue",
    '        if contains -- "$token" $value_opts',
    "            set skip 1",
    "            continue",
    "        end",
    "        string match -q -- '-*' \"$token\"; or set position (math $position + 1)",
    "    end",
    "    test $seen -eq 1; and test $skip -eq 0; and test $position -eq $target",
    "end",
    "function __xpl_guide_names",
    "    set -l tokens (commandline -opc)",
    "    set -l root .",
    "    set -l i 2",
    "    while test $i -le (count $tokens)",
    '        set -l token "$tokens[$i]"',
    '        if test "$token" = --root',
    "            set i (math $i + 1)",
    '            set root "$tokens[$i]"',
    '        else if string match -q -- "--root=*" "$token"',
    "            set root (string replace -r '^--root=' '' -- \"$token\")",
    "        end",
    "        set i (math $i + 1)",
    "    end",
    '    for file in "$root"/.explainer/*.explainer.json',
    '        test -f "$file"; or continue',
    "        string replace -r '\\.explainer\\.json$' '' -- (string replace -r '^.*/' '' -- \"$file\")",
    "    end",
    "end",
    "complete -c xpl -f",
    `complete -c xpl -n '__xpl_before_command' -a '${words(commands.map((c) => c.name))}'`,
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
        `complete -c xpl -n '__xpl_guide_at ${command.name} ${guidePosition(command)} ${words(valueFlags({ ...GLOBAL_OPTIONS, ...command.options }))}' -a '(__xpl_guide_names)'`,
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
      "under --root (default: current directory) when you complete an <explainer> argument.",
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
