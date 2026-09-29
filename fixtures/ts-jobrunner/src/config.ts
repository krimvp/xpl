import { readFileSync } from "node:fs";

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface Config {
  queue: { name: string; maxPending: number; idleDelayMs: number };
  workers: { count: number; namePrefix: string; timeoutMs: number };
  retry: RetryConfig;
  metrics: { enabled: boolean; prefix: string; printSummary: boolean };
}

/** The slice of configuration the runner needs. */
export interface RunnerConfig {
  idleDelayMs: number;
  timeoutMs: number;
  retry: RetryConfig;
}

type Scalar = string | number | boolean;
type Sections = Record<string, Record<string, Scalar>>;

/**
 * Parses the YAML subset used by config/default.yaml: top-level `section:` lines,
 * each followed by indented `key: value` lines. Comments start with `#`.
 */
export function parseYaml(text: string): Sections {
  const sections: Sections = {};
  let current: Record<string, Scalar> | undefined;

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/(^|\s)#.*$/, "").trimEnd();
    if (line.trim() === "") continue;

    const colon = line.indexOf(":");
    if (colon < 0) throw new Error(`config line ${index + 1}: expected "key: value"`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (!/^\s/.test(line)) {
      if (value !== "")
        throw new Error(`config line ${index + 1}: section "${key}" cannot have a value`);
      current = sections[key] = {};
    } else if (current === undefined) {
      throw new Error(`config line ${index + 1}: "${key}" is outside any section`);
    } else {
      current[key] = parseScalar(value);
    }
  }
  return sections;
}

function parseScalar(value: string): Scalar {
  if (value === "true" || value === "false") return value === "true";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

/** Reads and validates a config file. */
export function loadConfig(path: string | URL): Config {
  const sections = parseYaml(readFileSync(path, "utf8"));
  const text = (section: string, key: string): string => String(lookup(sections, section, key));
  const num = (section: string, key: string): number => {
    const value = lookup(sections, section, key);
    if (typeof value !== "number") throw new Error(`config: ${section}.${key} must be a number`);
    return value;
  };
  const flag = (section: string, key: string): boolean => {
    const value = lookup(sections, section, key);
    if (typeof value !== "boolean")
      throw new Error(`config: ${section}.${key} must be true or false`);
    return value;
  };

  return {
    queue: {
      name: text("queue", "name"),
      maxPending: num("queue", "maxPending"),
      idleDelayMs: num("queue", "idleDelayMs"),
    },
    workers: {
      count: num("workers", "count"),
      namePrefix: text("workers", "namePrefix"),
      timeoutMs: num("workers", "timeoutMs"),
    },
    retry: {
      maxRetries: num("retry", "maxRetries"),
      baseDelayMs: num("retry", "baseDelayMs"),
      maxDelayMs: num("retry", "maxDelayMs"),
    },
    metrics: {
      enabled: flag("metrics", "enabled"),
      prefix: text("metrics", "prefix"),
      printSummary: flag("metrics", "printSummary"),
    },
  };
}

/** Picks the values the runner needs out of a full config. */
export function runnerConfig(config: Config): RunnerConfig {
  return {
    idleDelayMs: config.queue.idleDelayMs,
    timeoutMs: config.workers.timeoutMs,
    retry: config.retry,
  };
}

function lookup(sections: Sections, section: string, key: string): Scalar {
  const value = sections[section]?.[key];
  if (value === undefined) throw new Error(`config: missing ${section}.${key}`);
  return value;
}
