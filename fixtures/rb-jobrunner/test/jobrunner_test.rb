require "minitest/autorun"
require_relative "../lib/jobrunner"

class JobrunnerTest < Minitest::Test
  def test_runs_jobs_in_order
    assert_equal ["first", "second"], Jobrunner.run([-> { "first" }, -> { "second" }])
  end

  def test_empty_queue
    assert_equal [], Jobrunner.run([])
  end
end
