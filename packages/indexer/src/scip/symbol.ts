/**
 * Parser for SCIP symbol strings (the grammar in `scip.proto`, message `Symbol`):
 *
 *   <symbol>     ::= <scheme> ' ' <manager> ' ' <package-name> ' ' <version> ' ' (<descriptor>)+ | 'local ' <id>
 *   <descriptor> ::= <name> '/' (namespace) | <name> '#' (type) | <name> '.' (term) | <name> ':' (meta)
 *                  | <name> '!' (macro) | <name> '(' [<disambiguator>] ').' (method)
 *                  | '[' <name> ']' (type parameter) | '(' <name> ')' (parameter)
 *   <name>       ::= a simple identifier, or `escaped text` with doubled backticks; spaces in the four
 *                    package fields are doubled.
 *
 * The importer only needs a few facts (is it local, what is the last descriptor, what would the symbol's path
 * be in our index), so the parser is lenient: a simple name runs up to the next suffix character.
 */

export type DescriptorSuffix =
  "namespace" | "type" | "term" | "method" | "type-parameter" | "parameter" | "meta" | "macro";

export interface ScipDescriptor {
  name: string;
  suffix: DescriptorSuffix;
  /** Only methods have one (overload marker), otherwise "". */
  disambiguator: string;
}

export interface ScipSymbol {
  scheme: string;
  manager: string;
  packageName: string;
  version: string;
  descriptors: ScipDescriptor[];
}

/** `local 12`: a symbol that cannot be referenced outside its document. */
export function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith("local ");
}

/** Read one space-terminated package field (a doubled space is an escaped space). */
function readField(text: string, from: number): { value: string; next: number } | undefined {
  let value = "";
  let i = from;
  while (i < text.length) {
    const c = text[i]!;
    if (c === " ") {
      if (text[i + 1] === " ") {
        value += " ";
        i += 2;
        continue;
      }
      return { value, next: i + 1 };
    }
    value += c;
    i++;
  }
  return undefined;
}

/**
 * The symbol without its package version (the fourth field): the same declaration named by the indexes of
 * different modules of one repository. Local and malformed symbols are returned as they are.
 */
export function withoutVersion(symbol: string): string {
  if (isLocalSymbol(symbol)) return symbol;
  let i = 0;
  for (let n = 0; n < 3; n++) {
    const field = readField(symbol, i);
    if (!field) return symbol;
    i = field.next;
  }
  const version = readField(symbol, i);
  return version ? `${symbol.slice(0, i)}~ ${symbol.slice(version.next)}` : symbol;
}

/** Characters that end a simple (unescaped) descriptor name. */
const NAME_END = new Set(["/", "#", ".", ":", "!", "(", ")", "[", "]"]);

/**
 * Parse a global symbol. Undefined for local symbols, the empty string and anything that does not follow the
 * grammar closely enough to read its descriptors.
 */
export function parseScipSymbol(text: string): ScipSymbol | undefined {
  if (text === "" || isLocalSymbol(text)) return undefined;
  const fields: string[] = [];
  let i = 0;
  for (let n = 0; n < 4; n++) {
    const field = readField(text, i);
    if (!field) return undefined;
    fields.push(field.value);
    i = field.next;
  }
  const descriptors: ScipDescriptor[] = [];
  while (i < text.length) {
    const c = text[i]!;
    if (c === "(" || c === "[") {
      // `(name)` parameter, `[name]` type parameter
      const close = c === "(" ? ")" : "]";
      const end = text.indexOf(close, i + 1);
      if (end < 0) return undefined;
      descriptors.push({
        name: text.slice(i + 1, end),
        suffix: c === "(" ? "parameter" : "type-parameter",
        disambiguator: "",
      });
      i = end + 1;
      continue;
    }
    let name = "";
    if (c === "`") {
      i++;
      for (;;) {
        if (i >= text.length) return undefined;
        const d = text[i]!;
        if (d === "`") {
          if (text[i + 1] === "`") {
            name += "`";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        name += d;
        i++;
      }
    } else {
      const start = i;
      while (i < text.length && !NAME_END.has(text[i]!)) i++;
      name = text.slice(start, i);
    }
    const suffixChar = text[i];
    i++;
    switch (suffixChar) {
      case "/":
        descriptors.push({ name, suffix: "namespace", disambiguator: "" });
        break;
      case "#":
        descriptors.push({ name, suffix: "type", disambiguator: "" });
        break;
      case ".":
        descriptors.push({ name, suffix: "term", disambiguator: "" });
        break;
      case ":":
        descriptors.push({ name, suffix: "meta", disambiguator: "" });
        break;
      case "!":
        descriptors.push({ name, suffix: "macro", disambiguator: "" });
        break;
      case "(": {
        const end = text.indexOf(")", i);
        if (end < 0 || text[end + 1] !== ".") return undefined;
        descriptors.push({ name, suffix: "method", disambiguator: text.slice(i, end) });
        i = end + 2;
        break;
      }
      default:
        return undefined;
    }
  }
  if (descriptors.length === 0) return undefined;
  const [scheme, manager, packageName, version] = fields as [string, string, string, string];
  return { scheme, manager, packageName, version, descriptors };
}

/** Marker names indexers give constructors (`<constructor>` in scip-typescript). */
const CONSTRUCTOR_NAME = "<constructor>";

/** Is the last descriptor a constructor (scip-typescript: `Queue#`<constructor>`().`)? */
export function isConstructorSymbol(symbol: ScipSymbol): boolean {
  const last = symbol.descriptors[symbol.descriptors.length - 1];
  return last?.suffix === "method" && last.name === CONSTRUCTOR_NAME;
}

/**
 * Does the symbol stand for a whole module or package (a namespace descriptor, or a Python module's
 * `__init__:` marker)? Such symbols are defined once per file at the top of the file, not by a declaration.
 */
export function isModuleSymbol(symbol: ScipSymbol): boolean {
  const last = symbol.descriptors[symbol.descriptors.length - 1];
  if (!last) return false;
  return last.suffix === "namespace" || (last.suffix === "meta" && last.name === "__init__");
}

/** Is the symbol a type (class, interface, struct, alias...) judging by its last descriptor alone? */
export function isTypeSymbol(symbol: ScipSymbol): boolean {
  return symbol.descriptors[symbol.descriptors.length - 1]?.suffix === "type";
}

/**
 * The dotted path our index would use for the declaration this symbol names, e.g. `Runner.dispatch` for
 * scip-typescript's `src/`runner.ts`/Runner#dispatch().`: the names of the type, term and method
 * descriptors after the module/package part. Undefined when the symbol is not a plain declaration (module
 * symbols, parameters, type parameters, macros and synthetic `meta` members such as `typeLiteral0:`).
 */
export function symbolPath(symbol: ScipSymbol): string | undefined {
  const parts: string[] = [];
  for (const d of symbol.descriptors) {
    switch (d.suffix) {
      case "namespace":
        if (parts.length > 0) return undefined; // a namespace below a member: not a declaration we index
        break;
      case "type":
      case "term":
      case "method":
        parts.push(memberName(d.name));
        break;
      default:
        return undefined;
    }
  }
  return parts.length > 0 ? parts.join(".") : undefined;
}

/** `<constructor>` -> `constructor`, `<get>size` / `<set>size` -> `size`. */
function memberName(name: string): string {
  if (name === CONSTRUCTOR_NAME) return "constructor";
  const accessor = /^<(?:get|set)>(.+)$/.exec(name);
  return accessor ? accessor[1]! : name;
}
