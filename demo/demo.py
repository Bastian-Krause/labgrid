from labgrid import Environment

env = Environment("/demo/env.yaml")
target = env.get_target("main")

strategy = target.get_strategy()

strategy.transition("barebox")

# barebox is up -- the prompt is yours now. What to try is listed under the
# panes, along with what each piece of this page actually is.
