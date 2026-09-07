import enum

import attr

from labgrid.factory import target_factory
from labgrid.step import step
from labgrid.strategy import Strategy, StrategyError, never_retry


class Status(enum.Enum):
    unknown = 0
    off = 1
    barebox = 2
    shell = 3


@target_factory.reg_driver
@attr.s(eq=False)
class QEMUBareboxStrategy(Strategy):
    """QEMUBareboxStrategy - Strategy to switch to barebox or shell"""
    bindings = {
        "qemu": "QEMUDriver",
        "barebox": "BareboxDriver",
        "shell": "ShellDriver",
    }

    status = attr.ib(default=Status.unknown)

    def __attrs_post_init__(self):
        super().__attrs_post_init__()

    @never_retry
    @step(args=["status"])
    def transition(self, status, *, step):
        if not isinstance(status, Status):
            status = Status[status]
        if status == Status.unknown:
            raise StrategyError(f"can not transition to {status}")
        elif status == self.status:
            step.skip("nothing to do")
            return
        elif status == Status.off:
            self.target.deactivate(self.barebox)
            self.target.deactivate(self.shell)
            self.target.activate(self.qemu)
            self.qemu.off()
        elif status == Status.barebox:
            self.transition(Status.off)
            # power on
            self.qemu.on()
            # interrupt barebox
            self.target.activate(self.barebox)
        elif status == Status.shell:
            # tansition to barebox
            self.transition(Status.barebox)
            # boot the disk's boot loader specification entry, then let
            # the stock ShellDriver log in once BusyBox' getty is up
            self.barebox.boot("")
            self.barebox.await_boot()
            self.target.activate(self.shell)
        else:
            raise StrategyError(f"no transition found from {self.status} to {status}")

        self.status = status

    @never_retry
    @step(args=["status"])
    def force(self, status, *, step):
        """Declare the board's state without driving it there.

        What --lg-initial-state drives, and what a fresh session implicitly
        starts from. Unlike upstream's strategies this also accepts unknown:
        they never need to force it, because a new process begins there, but
        here one strategy object outlives a pytest run and has to be able to
        say "I no longer know". Nothing is activated for it -- the next
        transition deactivates whatever is stale on its way through off.
        """
        if not isinstance(status, Status):
            status = Status[status]
        if status == Status.barebox:
            self.target.activate(self.barebox)
        elif status == Status.shell:
            self.target.activate(self.shell)
        elif status not in (Status.unknown, Status.off):
            raise StrategyError(f"can not force state {status}")

        self.status = status
