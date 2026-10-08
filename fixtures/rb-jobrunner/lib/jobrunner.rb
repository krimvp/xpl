require_relative "jobrunner/queue"
require_relative "jobrunner/runner"

module Jobrunner
  DEFAULT_RETRIES = 2

  def self.run(jobs)
    queue = Queue.new
    jobs.each { |job| queue.push(job) }
    Runner.new(queue).drain
  end
end
