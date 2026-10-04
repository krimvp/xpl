use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::Duration;

pub static DEFAULT_CONFIG: &str = include_str!("../config/default.yaml");
pub type Sections = HashMap<String, HashMap<String, String>>;

#[derive(Clone)]
pub struct RetryConfig {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
}

pub struct RunnerConfig {
    pub idle_delay: Duration,
    pub timeout: Duration,
    pub retry: RetryConfig,
}

pub struct Config {
    pub queue_name: String,
    pub max_pending: usize,
    pub idle_delay_ms: u64,
    pub worker_count: usize,
    pub worker_prefix: String,
    pub timeout_ms: u64,
    pub retry: RetryConfig,
    pub metrics_enabled: bool,
    pub metrics_prefix: String,
    pub print_summary: bool,
}

pub fn parse_yaml(text: &str) -> Result<Sections, String> {
    let mut sections = Sections::new();
    let mut current = String::new();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.split('#').next().unwrap().trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let (key, value) = line
            .split_once(':')
            .ok_or_else(|| format!("config line {}: expected key: value", index + 1))?;
        if !line.starts_with(char::is_whitespace) {
            if !value.trim().is_empty() {
                return Err("section cannot have a value".into());
            }
            current = key.trim().into();
            sections.insert(current.clone(), HashMap::new());
        } else {
            let section = sections.get_mut(&current).ok_or("key outside a section")?;
            section.insert(
                key.trim().into(),
                value.trim().trim_matches('"').trim_matches('\'').into(),
            );
        }
    }
    Ok(sections)
}

pub fn load_config(path: impl AsRef<Path>) -> Result<Config, String> {
    config_from_text(&fs::read_to_string(path).map_err(|error| error.to_string())?)
}

pub fn config_from_text(text: &str) -> Result<Config, String> {
    let sections = parse_yaml(text)?;
    let value = |section: &str, key: &str| -> Result<String, String> {
        sections
            .get(section)
            .and_then(|s| s.get(key))
            .cloned()
            .ok_or_else(|| format!("config: missing {section}.{key}"))
    };
    let number = |section, key| -> Result<u64, String> {
        value(section, key)?
            .parse()
            .map_err(|_| format!("config: {section}.{key} must be a nonnegative integer"))
    };
    let flag = |section, key| -> Result<bool, String> {
        value(section, key)?
            .parse()
            .map_err(|_| format!("config: {section}.{key} must be true or false"))
    };
    let config = Config {
        queue_name: value("queue", "name")?,
        max_pending: number("queue", "maxPending")?
            .try_into()
            .map_err(|_| "maxPending too large")?,
        idle_delay_ms: number("queue", "idleDelayMs")?,
        worker_count: number("workers", "count")?
            .try_into()
            .map_err(|_| "worker count too large")?,
        worker_prefix: value("workers", "namePrefix")?,
        timeout_ms: number("workers", "timeoutMs")?,
        retry: RetryConfig {
            max_retries: number("retry", "maxRetries")?
                .try_into()
                .map_err(|_| "maxRetries too large")?,
            base_delay_ms: number("retry", "baseDelayMs")?,
            max_delay_ms: number("retry", "maxDelayMs")?,
        },
        metrics_enabled: flag("metrics", "enabled")?,
        metrics_prefix: value("metrics", "prefix")?,
        print_summary: flag("metrics", "printSummary")?,
    };
    if config.worker_count == 0 {
        return Err("worker count must be positive".into());
    }
    Ok(config)
}

pub fn runner_config(config: &Config) -> RunnerConfig {
    RunnerConfig {
        idle_delay: Duration::from_millis(config.idle_delay_ms),
        timeout: Duration::from_millis(config.timeout_ms),
        retry: config.retry.clone(),
    }
}
