from labgrid import Environment

env = Environment("/demo/env.yaml")
target = env.get_target("main")

strategy = target.get_strategy()

strategy.transition("barebox")
