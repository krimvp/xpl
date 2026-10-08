module Jobrunner
  class Queue
    def initialize
      @items = []
    end

    def push(job)
      @items << job
    end

    def pop
      @items.shift
    end

    def empty?
      @items.empty?
    end
  end
end
