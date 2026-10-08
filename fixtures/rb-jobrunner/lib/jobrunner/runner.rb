module Jobrunner
  class Runner
    def initialize(queue)
      @queue = queue
    end

    def drain
      results = []
      results << @queue.pop.call until @queue.empty?
      results
    end
  end
end
