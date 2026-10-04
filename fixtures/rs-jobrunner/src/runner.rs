use crate::config::{RetryConfig, RunnerConfig};
use crate::queue::{Job, JobQueue};
use crate::worker::{RunResult, WorkerPool};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub type Logger = Box<dyn Fn(&str)>;

macro_rules! counters {
    ($name:ident) => {
        #[derive(Default)]
        pub struct $name {
            pub processed: usize,
            pub dead_lettered: usize,
            pub ms_by_type: HashMap<String, u128>,
        }
    };
}
counters!(RunnerStats);

impl RunnerStats {
    pub fn record(&mut self, job: &Job, elapsed_ms: u128) {
        self.processed += 1;
        *self.ms_by_type.entry(job.kind.clone()).or_default() += elapsed_ms;
    }
}

pub struct Runner<Q: JobQueue> {
    pub queue: Q,
    pub stats: RunnerStats,
    pool: WorkerPool,
    config: RunnerConfig,
    logger: Logger,
    running: Arc<AtomicBool>,
}

impl<Q: JobQueue> Runner<Q> {
    pub fn new(queue: Q, pool: WorkerPool, config: RunnerConfig, logger: Logger) -> Self {
        Self {
            queue,
            stats: RunnerStats::default(),
            pool,
            config,
            logger,
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn stop_handle(&self) -> Arc<AtomicBool> {
        self.running.clone()
    }

    pub fn start(&mut self) {
        self.running.store(true, Ordering::SeqCst);
        self.dispatch();
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn dispatch(&mut self) {
        while self.running.load(Ordering::SeqCst) && self.queue.size() > 0 {
            let Some(job) = self.queue.pop() else {
                thread::sleep(self.config.idle_delay);
                continue;
            };
            let mut worker = self.pool.lease();
            let started = Instant::now();
            (self.logger)(&format!(
                "dispatching {} (attempt {})",
                job.id,
                job.attempts + 1
            ));
            let result = worker.run(&job, self.config.timeout);
            self.pool.release(worker);
            self.stats.record(&job, started.elapsed().as_millis());
            match result {
                RunResult::Success { .. } => self.queue.ack(job),
                RunResult::Failure { error, .. } => {
                    let attempts = job.attempts + 1;
                    if attempts <= self.config.retry.max_retries {
                        let delay = backoff_delay(attempts, &self.config.retry);
                        self.queue.requeue(job, delay);
                    } else {
                        (self.logger)(&format!(
                            "dead-lettered {} after {attempts} attempts",
                            job.id
                        ));
                        self.queue.dead_letter(job, error);
                        self.stats.dead_lettered += 1;
                    }
                }
            }
        }
        self.stop();
        (self.logger)("dispatch loop stopped");
    }
}

pub fn backoff_delay(attempt: u32, retry: &RetryConfig) -> Duration {
    let factor = 1u64
        .checked_shl(attempt.saturating_sub(1))
        .unwrap_or(u64::MAX);
    Duration::from_millis(
        retry
            .base_delay_ms
            .saturating_mul(factor)
            .min(retry.max_delay_ms),
    )
}
